import { existsSync } from 'node:fs';
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
  PublishPlan,
  SelectTaskInput,
  SelectedTask,
} from '../types';
import { isConfigured, loadIosConfig, type IosConfig } from './config';
import { loadFlowsFromRepo, syncFlowsToRegistry } from './flows';
import { buildPublishPlan, registerEvidenceArtifacts } from './issue';
import { parseFlowMarkers, parseIosQaFindings } from './parser';
import { parsePlanHint, resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import { ObeliskError } from '../../../shared/errors';

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
    const cfg = loadIosConfig(input.repo.localPath);
    if (!isConfigured(cfg)) {
      throw new ObeliskError(
        'IOS_QA_NOT_CONFIGURED',
        'iOS QA Pilot is missing its config. Add a `qa/ios.yml` with `app_path` and `bundle_id` set.',
        'See the iOS QA Pilot setup screen for the expected config shape.',
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
    const flowsParsed = loadFlowsFromRepo(input.repo.localPath, cfg.flowsDir);
    if (flowsParsed.length === 0) {
      throw new ObeliskError(
        'IOS_QA_NO_FLOWS',
        `No flow files found in \`${cfg.flowsDir}\`. Add at least one \`*.flow.md\` file describing what to test.`,
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
        ref: `ios-qa:${flow.flowId}:${tempRunId}`,
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
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const flowId = extractFlowIdFromTaskRef(input.task.ref);
    const tempRunId = extractTempRunId(input.task.ref);

    // Always release the simulator slot once we get here.
    if (tempRunId) releaseSimSlot(tempRunId);

    if (!flowId) return [];
    const flow = getFlow(flowId);
    if (!flow) return [];

    const markers = parseFlowMarkers(input.runResult.reasoning);
    const findings = parseIosQaFindings(input.runResult.reasoning).filter(
      (f) => f.flow_id === flowId && f.confidence >= 0.7,
    );

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
  // ref shape: "ios-qa:<flow_id>:<temp_run_id>"
  const match = /^ios-qa:([^:]+):/.exec(ref);
  return match ? match[1]! : null;
}

function extractTempRunId(ref: string): string | null {
  const match = /^ios-qa:[^:]+:(.+)$/.exec(ref);
  return match ? match[1]! : null;
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
  const flowAvailable = existsSync(flowSourceAbs)
    ? `(read it at ${flow.sourcePath})`
    : '(file no longer exists; rely on the title only)';
  return [
    `Run iOS flow "${flow.title}" ${flowAvailable}.`,
    `flow_id: ${flow.flowId}`,
    `Source: ${flow.sourcePath}`,
    '',
    `Simulator UDID: ${slot.udid}`,
    `Appium port: ${slot.appiumPort}`,
    `WebDriverAgent port: ${slot.wdaPort}`,
    `App bundle (.app): ${cfg.appPath}`,
    `Bundle id: ${cfg.bundleId}`,
    '',
    `Use the ios-simulator-control, appium-driving, and ios-evidence-capture skills.`,
    `Generated at ${ts}.`,
  ].join('\n');
}
