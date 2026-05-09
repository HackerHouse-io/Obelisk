import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import {
  allocateSimSlot,
  claimNextFlow,
  ensureRepoState,
  getFlow,
  getRepoCycle,
  getSetupAt,
  recordFlowOutcome,
  releaseFlowClaim,
  releaseSimSlot,
  type QaFlowRow,
} from '../../db/qa-flows';
import { appendAudit } from '../../logger/audit';
import type {
  AgentHandler,
  InterpretResultInput,
  PreRunInput,
  PublishPlan,
  RunInfra,
  SelectTaskInput,
  SelectedTask,
} from '../types';
import { appiumOnPath, bootSim, killAppium, spawnAppium, waitForAppium } from './run-infra';
import { applyMemoryUpdate, parseMemoryUpdate } from './memory';
import { isConfigured, loadIosConfig, saveIosConfig, type IosConfig } from './config';
import { scaffoldDefaultFlow } from './doctor';
import { buildApp, detectIosConfig } from './xcode-detect';
import { loadFlowsFromRepo, syncFlowsToRegistry } from './flows';
import { buildPublishPlan, registerEvidenceArtifacts } from './issue';
import { parseFlowMarkers, parseIosQaFindings, parseIosScreenSnapshots } from './parser';
import { detectStructuralDefects, type StructuralDefect } from './visual-detect';
import { parsePlanHint, resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import { ObeliskError } from '../../../shared/errors';
import { buildIosQaTaskRef, parseIosQaTaskRef } from '../../../shared/task-refs';

/**
 * The optional task hint format. The orchestrator passes `taskId` from
 * `agents:run` straight through to `selectTask`; we accept two shapes:
 *   - `flow:<flow_id>`  — pick a specific flow from the registry
 *   - `plan:<plan_id>`  — assign a test plan; flow is still chosen by the
 *                         normal picker (claimNextFlow). When neither is
 *                         set, we read the (single) repo plan or refuse.
 */
const FLOW_HINT_PREFIX = 'flow:';
const PLAN_HINT_PREFIX = 'plan:';

export const iosQaPilotHandler: AgentHandler = {
  name: 'ios-qa-pilot',
  // qa_ios_flows.claimed_run_id (UNIQUE WHERE NOT NULL) already guarantees
  // two instances pick different flows; same for qa_ios_sim_slots.
  multiInstance: true,
  addAnotherExplainer:
    'Each instance binds to a different simulator and verifies a different flow. Cap = available sim slots.',
  skipsEvidenceGate: true,
  producesPatch: false,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // Self-healing path. The user's mental model is: I clicked Run now,
    // it should run. If qa/ios.yml is missing or the flows directory is
    // empty, we try to fix it inline rather than throwing — these are
    // exactly the cases the user has no actionable button to recover
    // from. Only genuinely external prerequisites (Appium install, sim
    // pool bootstrap, a test plan) still throw, since those need the
    // separate setup ladder or the user's content.
    let cfg = loadIosConfig(input.repo.localPath);
    if (!isConfigured(cfg)) {
      const detected = await detectIosConfig(input.repo.localPath).catch(() => null);
      if (detected) {
        saveIosConfig(input.repo.localPath, {
          appPath: detected.appPath,
          bundleId: detected.bundleId,
        });
        cfg = loadIosConfig(input.repo.localPath);
      }
    }
    if (!isConfigured(cfg)) {
      throw new ObeliskError(
        'IOS_QA_NOT_CONFIGURED',
        'iOS QA Pilot is missing its config (qa/ios.yml) and could not auto-detect from xcodebuild.',
        'Open the iOS QA Pilot screen, click "Run setup" (auto-detects), or fill in app_path + bundle_id in the form.',
      );
    }
    if (!getSetupAt(input.repo.id)) {
      throw new ObeliskError(
        'IOS_QA_SETUP_REQUIRED',
        'iOS QA Pilot setup has not run yet — Appium and the simulator pool need to be installed first.',
        'Open the iOS QA Pilot screen and click "Run Setup". The button is idempotent and safe to re-click.',
      );
    }

    // Plan gate: iOS QA Pilot needs a plan for context, but the flow-registry
    // is still what picks WHICH flow to execute. parsePlanHint accepts the
    // explicit `plan:<id>` form; without it, resolvePlanForAgentRun looks up
    // the (single) plan registered for this agent or throws TEST_PLAN_REQUIRED.
    const planTaskId = parsePlanHint(input.taskId)
      ? input.taskId
      : `${PLAN_HINT_PREFIX}` +
        resolvePlanForAgentRun(input.repo, 'ios-qa-pilot', undefined).frontmatter.id;
    const plan = resolvePlanForAgentRun(input.repo, 'ios-qa-pilot', planTaskId);
    const assigned = toAssignedPlan(plan);

    ensureRepoState(input.repo.id);
    let flowsParsed = loadFlowsFromRepo(input.repo.localPath, cfg.flowsDir);
    if (flowsParsed.length === 0) {
      // Self-heal: most users hit this on first run with nothing to
      // click. Scaffold a default flow that walks the test plan on
      // the simulator and re-load. Run setup also does this, but
      // landing here means the user upgraded between setup runs and
      // never re-ran setup — Run now must still work.
      scaffoldDefaultFlow(input.repo.localPath, cfg.flowsDir);
      flowsParsed = loadFlowsFromRepo(input.repo.localPath, cfg.flowsDir);
    }
    if (flowsParsed.length === 0) {
      // Defensive: scaffold should have written the file. If we get
      // here, the filesystem is read-only or write failed silently —
      // surface the original message so the user has *something* to
      // act on.
      throw new ObeliskError(
        'IOS_QA_NO_FLOWS',
        `Could not write a default flow into \`${cfg.flowsDir}\`. Check the directory is writable.`,
        'Each flow file is a Markdown doc with a title and step-by-step instructions for the simulator.',
      );
    }
    syncFlowsToRegistry(input.repo.id, flowsParsed);

    const preferredFlowId = parseFlowHint(input.taskId);
    const tempRunId = ulid(); // claim before the orchestrator's run row exists

    const flow = claimNextFlow(input.repo.id, tempRunId, preferredFlowId);
    if (!flow) {
      // claimNextFlow returns null when every flow is either already
      // claimed by another live run or has status 'passed' in the current
      // cycle. Surface the actionable difference instead of a generic
      // "nothing to do".
      throw new ObeliskError(
        'IOS_QA_NOTHING_CLAIMABLE',
        'No iOS QA flows are claimable right now — they may all be passing in the current cycle, or another iOS QA Pilot instance has them claimed.',
        'Use "Reset iOS QA flows" on the iOS QA Pilot screen to re-test, or wait for in-flight runs to finish.',
      );
    }

    const slot = allocateSimSlot(tempRunId);
    if (!slot) {
      // No simulator slot free. Release the flow we just claimed so it
      // doesn't sit locked while the user waits for a slot to free up.
      releaseFlowClaim(flow.flowId, tempRunId);
      throw new ObeliskError(
        'IOS_QA_POOL_FULL',
        'iOS simulator pool is fully claimed. Wait for a current run to finish, or raise `max_parallel` in `qa/ios.yml`.',
        'Each in-flight iOS QA Pilot run holds one slot; the pool size = max_parallel.',
      );
    }

    const ts = new Date().toISOString();
    return {
      task: {
        // Task ref carries plan id at the end so Mission Control's
        // parsePlanIdFromTaskRef can find it and surface the per-case
        // plan tab on iOS QA Pilot runs (parity with QA Hunter).
        ref: buildIosQaTaskRef({
          flowId: flow.flowId,
          tempRunId,
          planId: plan.frontmatter.id,
        }),
        kind: 'qa',
        context: buildPromptContext({
          flow,
          cfg,
          slot,
          repoPath: input.repo.localPath,
          ts,
        }),
        assignedPlan: assigned,
      },
      iosSimSlot: {
        udid: slot.udid,
        appiumPort: slot.appiumPort,
        wdaPort: slot.wdaPort,
      },
    };
  },

  /**
   * Boot the assigned simulator and start an Appium server on its port
   * BEFORE the runner spawns. Without this the agent connects to a dead
   * socket and the run dies with FLOW_INCONCLUSIVE — which is exactly
   * what users have been hitting.
   *
   * Returns null (skipping infra spawn) when:
   *  - the slot is missing (defensive — selectTask should always set it)
   *  - the appium binary isn't on PATH (test environments, broken
   *    installs). In that case the agent's prompt still tells it where
   *    Appium SHOULD be; if it's not there the run fails with an
   *    actionable message rather than blocking the orchestrator on a
   *    60s startup poll.
   */
  async preRun(input: PreRunInput): Promise<RunInfra | null> {
    const slot = input.selected.iosSimSlot;
    if (!slot) return null;
    const audit = (step: string, extra: Record<string, unknown> = {}): void => {
      appendAudit({
        runId: input.runId,
        kind: 'state',
        payload: { kind: 'ios_qa_prerun', step, ...extra },
      });
    };

    if (!(await appiumOnPath())) {
      audit('skip', { reason: 'appium not on PATH' });
      return null;
    }

    const cfg = loadIosConfig(input.repo.localPath);

    // Sim boot and the app build are independent — start them in
    // parallel so the slow xcodebuild path doesn't serialize behind
    // the simulator wakeup.
    audit('boot', { udid: slot.udid });
    const bootPromise = bootSim(slot.udid);

    let buildError: unknown = null;
    let buildPromise: Promise<unknown> = Promise.resolve();
    if (cfg.autoBuild) {
      const detected = await detectIosConfig(input.repo.localPath).catch(() => null);
      if (detected) {
        const derivedDataPath = join(input.repo.localPath, 'build');
        audit('build-start', {
          scheme: detected.scheme,
          project: detected.project.path,
        });
        buildPromise = buildApp({
          project: detected.project,
          scheme: detected.scheme,
          derivedDataPath,
        }).then(
          (res) => {
            audit('build-completed', { durationMs: res.durationMs });
          },
          (e) => {
            buildError = e;
          },
        );
      } else {
        audit('build-skip', { reason: 'no Xcode project detected' });
      }
    } else {
      audit('build-skip', { reason: 'auto_build=false in qa/ios.yml' });
    }

    await Promise.all([bootPromise, buildPromise]);
    if (buildError) {
      throw new ObeliskError(
        'IOS_QA_BUILD_FAILED',
        buildError instanceof Error ? buildError.message : 'xcodebuild build failed.',
        'Run the xcodebuild command in a terminal to see the full output, or set `auto_build: false` in qa/ios.yml to disable per-run building.',
      );
    }

    audit('spawn-appium', { port: slot.appiumPort });
    const appiumChild = spawnAppium(slot.appiumPort);

    try {
      await waitForAppium(slot.appiumPort);
    } catch (e) {
      // Appium failed to start (most likely another process bound the
      // port). Kill the child so we don't leak it, then surface a
      // useful error.
      await killAppium(appiumChild).catch(() => undefined);
      throw new ObeliskError(
        'IOS_QA_APPIUM_FAILED',
        e instanceof Error ? e.message : 'Appium did not become ready.',
        'Check no other Appium server is bound to the port, or restart Run setup on the iOS QA Pilot screen.',
      );
    }

    audit('ready', { port: slot.appiumPort });

    return {
      teardown: async () => {
        await killAppium(appiumChild).catch(() => undefined);
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const flowId = extractFlowIdFromTaskRef(input.task.ref);
    const tempRunId = extractTempRunId(input.task.ref);

    // Always release the simulator slot once we get here.
    if (tempRunId) releaseSimSlot(tempRunId);

    // Per-project memory: agent emits a BEGIN_IOS_MEMORY_UPDATE block
    // at end of run with new selectors / app architecture / known
    // non-bugs / filed findings. Apply it before publishing so that
    // duplicate-suppression logic on the next run sees the latest
    // state. Failures here are non-fatal — the run still publishes.
    const memoryUpdate = parseMemoryUpdate(input.runResult.reasoning);
    if (memoryUpdate) {
      try {
        applyMemoryUpdate(input.repo.localPath, memoryUpdate);
        appendAudit({
          runId: input.runId,
          kind: 'memory_update',
          payload: { bytes: memoryUpdate.length, file: 'qa/ios-pilot-memory.md' },
        });
      } catch (e) {
        appendAudit({
          runId: input.runId,
          kind: 'memory_update',
          payload: {
            error: e instanceof Error ? e.message : String(e),
            bytes: memoryUpdate.length,
          },
        });
      }
    }

    if (!flowId) return [];
    const flow = getFlow(flowId);
    if (!flow) return [];

    const markers = parseFlowMarkers(input.runResult.reasoning);
    // Confidence floor varies by category: visual defects often live
    // at 0.6 (the agent saw it but can't prove intent vs. bug);
    // functional regressions require 0.7. The agent tags each finding.
    const agentFindings = parseIosQaFindings(input.runResult.reasoning).filter(
      (f) => f.flow_id === flowId && f.confidence >= (f.category === 'visual' ? 0.6 : 0.7),
    );

    // Run deterministic structural defect detection over each
    // BEGIN_IOS_SCREEN_SNAPSHOT block. Bound-arithmetic rules are
    // expensive for the agent and reliable in code, so this runs
    // here without burning tokens.
    const snapshots = parseIosScreenSnapshots(input.runResult.reasoning);
    const autoFindings = autoFindingsFromSnapshots(snapshots, flowId);
    if (autoFindings.length > 0) {
      appendAudit({
        runId: input.runId,
        kind: 'ios_qa_auto_detect',
        payload: {
          screens: snapshots.length,
          structural_defects: autoFindings.length,
        },
      });
    }
    const findings = mergeFindings(agentFindings, autoFindings);

    if (markers.ok.includes(flowId) && findings.length === 0) {
      recordFlowOutcome({
        flowId,
        runId: tempRunId ?? input.runId,
        status: 'passed',
        findingCount: 0,
      });
      return [{ kind: 'noop', reason: 'flow passed' }];
    }

    if (markers.inconclusive.some((m) => m.flowId === flowId)) {
      recordFlowOutcome({
        flowId,
        runId: tempRunId ?? input.runId,
        status: 'inconclusive',
        findingCount: 0,
      });
      return [{ kind: 'noop', reason: 'flow inconclusive' }];
    }

    if (findings.length === 0) {
      // No structured signal — leave the row claim for the stale-claim sweeper.
      return [];
    }

    const cycle = getRepoCycle(flow.repoId);
    const out: PublishPlan[] = [];
    for (const finding of findings) {
      const refs = registerEvidenceArtifacts({
        finding,
        repoPath: input.repo.localPath,
        runId: input.runId,
      });
      const plan = await buildPublishPlan({
        repoId: flow.repoId,
        repoFullName: input.repo.githubFullName,
        flowId,
        flowTitle: flow.title,
        finding,
        refs,
        cycle,
        runId: input.runId,
      });
      out.push(plan);
      appendAudit({
        runId: input.runId,
        kind: 'ios_qa_finding',
        payload: {
          flow_id: flowId,
          severity: finding.severity,
          confidence: finding.confidence,
          plan_kind: plan.kind,
        },
      });
    }

    recordFlowOutcome({
      flowId,
      runId: tempRunId ?? input.runId,
      status: 'failed',
      findingCount: findings.length,
    });

    return out;
  },
};

/* ---------- helpers ---------- */

function parseFlowHint(taskId: string | undefined): string | undefined {
  if (!taskId) return undefined;
  return taskId.startsWith(FLOW_HINT_PREFIX) ? taskId.slice(FLOW_HINT_PREFIX.length) : undefined;
}

function extractFlowIdFromTaskRef(ref: string): string | null {
  return parseIosQaTaskRef(ref)?.flowId ?? null;
}

function extractTempRunId(ref: string): string | null {
  return parseIosQaTaskRef(ref)?.tempRunId ?? null;
}

/**
 * Convert deterministic structural defects from each snapshot into
 * IosQaFindings. The agent is told to dump per-screen XCUI source —
 * we then run rule-based detection over each and emit findings as
 * if the agent had reported them. Keeps the agent's token spend
 * focused on what only an LLM can do (subjective visuals).
 */
function autoFindingsFromSnapshots(
  snapshots: ReturnType<typeof parseIosScreenSnapshots>,
  flowId: string,
): import('./parser').IosQaFinding[] {
  const out: import('./parser').IosQaFinding[] = [];
  for (const snap of snapshots) {
    const defects = detectStructuralDefects(snap.xcuiSource);
    for (const d of defects) {
      out.push(structuralDefectToFinding(d, snap, flowId));
    }
  }
  return out;
}

function structuralDefectToFinding(
  d: StructuralDefect,
  snap: { screenId: string; screenshotPath?: string },
  flowId: string,
): import('./parser').IosQaFinding {
  const refType = humanizeType(d.element.type);
  const elementText = d.element.name ?? d.element.label ?? '';
  return {
    flow_id: flowId,
    status: 'failed',
    category: 'visual',
    symptom: d.symptom,
    severity: d.severity,
    repro: `1. Reach the "${snap.screenId}" screen. 2. Inspect ${refType}${elementText ? ` "${elementText}"` : ''} at bounds (${d.element.bounds.x}, ${d.element.bounds.y}, ${d.element.bounds.width}×${d.element.bounds.height}).`,
    likely_area: `${snap.screenId} (${refType} layout/constraints)`,
    confidence: 0.85,
    evidence: snap.screenshotPath ? { screenshots: [snap.screenshotPath] } : {},
  };
}

function humanizeType(type: string): string {
  return type.replace(/^XCUIElementType/, '');
}

/**
 * Merge agent-emitted findings with orchestrator-detected ones. When
 * both layers found the same defect (matching screen + rule shape) we
 * keep the orchestrator's deterministic version because its
 * confidence is constant and its bounds are exact.
 */
function mergeFindings(
  agentFindings: import('./parser').IosQaFinding[],
  autoFindings: import('./parser').IosQaFinding[],
): import('./parser').IosQaFinding[] {
  const seenSymptoms = new Set(
    autoFindings.map((f) => f.symptom.replace(/\s+/g, ' ').toLowerCase().slice(0, 80)),
  );
  const out = [...autoFindings];
  for (const af of agentFindings) {
    const key = af.symptom.replace(/\s+/g, ' ').toLowerCase().slice(0, 80);
    if (seenSymptoms.has(key)) continue;
    out.push(af);
  }
  return out;
}

function buildPromptContext(opts: {
  flow: QaFlowRow;
  cfg: IosConfig;
  slot: { udid: string; appiumPort: number; wdaPort: number };
  repoPath: string;
  ts: string;
}): string {
  const { flow, cfg, slot, repoPath, ts } = opts;
  const flowSourceAbs = join(repoPath, flow.sourcePath);
  // Read the flow body from the canonical repo and inline it. The
  // orchestrator runs the agent in an ephemeral git worktree that does
  // NOT contain freshly-scaffolded flow files, so directing the agent
  // to "read it at <path>" fails with file-not-found. Inlining sidesteps
  // the worktree entirely and removes one source of FLOW_INCONCLUSIVE
  // failures.
  let flowBody = '';
  try {
    if (existsSync(flowSourceAbs)) {
      flowBody = readFileSync(flowSourceAbs, 'utf8');
    }
  } catch {
    flowBody = '';
  }
  const flowSection = flowBody
    ? [
        'Flow file (verbatim — already inlined; no need to read from disk):',
        '```md',
        flowBody.trimEnd(),
        '```',
      ]
    : ['Flow file content was not readable; rely on the title and run a sensible smoke pass.'];

  // Always emit an absolute path to the .app. The agent runs inside an
  // ephemeral git worktree where `cfg.appPath` (relative to the
  // canonical repo) won't resolve — the orchestrator built the .app
  // into `<canonical>/build/...` and the agent must install from
  // there via `xcrun simctl install <udid> <abs-path>`.
  const appAbs = join(repoPath, cfg.appPath);
  const appExists = existsSync(appAbs);
  const buildHint = cfg.autoBuild
    ? 'Obelisk ran `xcodebuild build` before this prompt, so the .app is fresh.'
    : 'auto_build=false in qa/ios.yml — the orchestrator did NOT rebuild; install whatever is at the path above.';

  return [
    `Run iOS flow "${flow.title}".`,
    `flow_id: ${flow.flowId}`,
    `Source path (informational only): ${flow.sourcePath}`,
    '',
    `Simulator UDID: ${slot.udid} — already booted by Obelisk before this prompt.`,
    `Appium server: http://127.0.0.1:${slot.appiumPort}/wd/hub — already running. Connect directly; do NOT spawn a second server.`,
    `WebDriverAgent port: ${slot.wdaPort} (Appium will start WDA on demand).`,
    `App bundle (.app, absolute path): ${appAbs}${appExists ? ' (present)' : ' (NOT FOUND — see below)'}`,
    `Bundle id: ${cfg.bundleId}`,
    `Build status: ${buildHint}`,
    '',
    ...flowSection,
    '',
    appExists
      ? 'Install + launch via `xcrun simctl install <UDID> <ABS-PATH>`, then drive Appium.'
      : 'IMPORTANT: the .app bundle is missing at the absolute path above. The orchestrator either failed to build (check audit log) or auto_build is off and your app was never built. Emit FLOW_INCONCLUSIVE with the reason.',
    '',
    `Use the ios-simulator-control, appium-driving, and ios-evidence-capture skills.`,
    `Generated at ${ts}.`,
  ].join('\n');
}
