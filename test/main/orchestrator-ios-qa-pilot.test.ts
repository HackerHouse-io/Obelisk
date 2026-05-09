import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { runAgent } from '../../src/main/orchestrator/run';
import { listFlows, setSetupAt, upsertSimSlot } from '../../src/main/db/qa-flows';
import { MockRunner, type MockRecipe } from '../helpers/mock-runner';
import { seedTestPlanFile } from '../helpers/seed-plan';

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;
let repoId: string;

const IOS_YML = `app_path: build/Debug-iphonesimulator/Foo.app
bundle_id: com.example.foo
simulator_device: iPhone 15
max_parallel: 2
`;

const FLOW_LOGIN = `---
title: Login happy path
priority: P0
---
# Steps
1. Tap Sign in.
2. Enter creds.
3. Verify home tab bar.
`;

const FLOW_SIGNUP = `---
title: Signup
priority: P1
---
# Steps
1. Tap Create account.
2. Verify success modal.
`;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-ios-orch-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

  repoPath = join(tmpRoot, 'repo');
  mkdirSync(join(repoPath, 'qa', 'ios-flows'), { recursive: true });
  writeFileSync(join(repoPath, 'qa', 'ios.yml'), IOS_YML);
  writeFileSync(join(repoPath, 'qa', 'ios-flows', 'login.flow.md'), FLOW_LOGIN);
  writeFileSync(join(repoPath, 'qa', 'ios-flows', 'signup.flow.md'), FLOW_SIGNUP);
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);

  const repo = createRepo({
    githubFullName: 'test/ios-app',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe', // previews go to audit_log; no real GitHub publish
    defaultRunner: 'claude',
  });
  repoId = repo.id;
  createAgent({ repoId, name: 'ios-qa-pilot' });

  // Pretend Doctor setup ran successfully.
  setSetupAt(repoId, new Date().toISOString());
  upsertSimSlot({ slotIndex: 0, udid: 'udid-0', appiumPort: 4723, wdaPort: 8100 });
  upsertSimSlot({ slotIndex: 1, udid: 'udid-1', appiumPort: 4724, wdaPort: 8101 });

  // Plan gate: a test plan must exist for the agent to run.
  seedTestPlanFile({ repoPath, agentName: 'ios-qa-pilot' });
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('orchestrator: ios-qa-pilot', () => {
  it('throws IOS_QA_SETUP_REQUIRED when Doctor has not run, instead of silently returning "nothing to do"', async () => {
    setSetupAt(repoId, null);
    await expect(
      runAgent({
        repoId,
        agentName: 'ios-qa-pilot',
        trigger: 'manual',
        runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'IOS_QA_SETUP_REQUIRED',
      hint: expect.stringContaining('Run Setup'),
    });
  });

  it('still throws IOS_QA_NOT_CONFIGURED when no Xcode project is detectable to auto-fill from', async () => {
    // selectTask self-heals by calling xcodebuild — but without an
    // .xcodeproj/.xcworkspace in the repo, detectIosConfig returns null
    // and the original error is the right thing to surface.
    writeFileSync(join(repoPath, 'qa', 'ios.yml'), '# nothing\n');
    await expect(
      runAgent({
        repoId,
        agentName: 'ios-qa-pilot',
        trigger: 'manual',
        runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'IOS_QA_NOT_CONFIGURED',
    });
  });

  it('selectTask attaches iosSimSlot and inlines the flow body in the prompt context', async () => {
    // Regression: the agent prompt used to point at the flow file by
    // path, and the orchestrator runs the agent in a worktree that
    // doesn't have the freshly-scaffolded files. Inlining the flow body
    // sidesteps the worktree entirely. The slot also flows through to
    // the orchestrator's preRun via SelectedTask.iosSimSlot.
    const { iosQaPilotHandler } = await import('../../src/main/agents/ios-qa-pilot/index');
    const repo = (await import('../../src/main/db/repos')).getRepo(repoId)!;
    const selected = await iosQaPilotHandler.selectTask({
      repo,
      defaultRunner: 'claude',
    });
    expect(selected).not.toBeNull();
    expect(selected!.iosSimSlot).toBeDefined();
    expect(selected!.iosSimSlot!.appiumPort).toBeGreaterThan(0);
    expect(selected!.iosSimSlot!.udid).toMatch(/udid-/);
    // Prompt context contains the verbatim flow body, not just a path.
    expect(selected!.task.context).toContain('Flow file (verbatim');
    expect(selected!.task.context).toMatch(/Login happy path|Signup/);
    // And the prompt makes clear that Appium is already up.
    expect(selected!.task.context).toMatch(/already running/i);
    expect(selected!.task.context).toMatch(/already booted/i);
  });

  it('self-heals an empty flows directory by scaffolding a default flow on Run now', async () => {
    // The user-reported regression: clicking Run now with no flow files
    // used to throw IOS_QA_NO_FLOWS with a dead-end "add a *.flow.md"
    // message. selectTask now auto-scaffolds a default flow so dispatch
    // succeeds without any extra clicks.
    rmSync(join(repoPath, 'qa', 'ios-flows', 'login.flow.md'));
    rmSync(join(repoPath, 'qa', 'ios-flows', 'signup.flow.md'));
    const before = listFlows(repoId);
    expect(before.length).toBe(0);

    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) =>
        new MockRunner(kind, { filesToWrite: [], reasoning: 'FLOW_OK app-sweep\n' }),
    });
    expect(result.runId).toBeDefined();

    // The scaffold landed on disk and got registered as a real flow.
    const after = listFlows(repoId);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((f) => f.title === 'App sweep')).toBe(true);
  });

  it('runs a flow → emits a finding → records the outcome as failed', async () => {
    // Sync the flows so they exist in the registry, then peek at one's flow_id.
    // The handler does the sync itself in selectTask; we just need the
    // recipe to reference whatever id ends up in the registry. We get it by
    // running selectTask once, capturing what was claimed, then crafting
    // the recipe around that id.
    //
    // Simpler approach: run twice — first time observes the flow_id, second
    // time emits a recipe targeting it. But we can also spy on parseFrontmatter
    // → just compute the id deterministically here.
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');

    const recipe: MockRecipe = {
      // Write a marker so MockRunner produces a non-empty diff. The
      // orchestrator currently drops `reasoning` when the result is the
      // synthetic `no_changes`, so read-only agents that need structured
      // output rely on the runner having SOMETHING in the worktree.
      filesToWrite: [{ path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' }],
      reasoning: `Drove the flow.

BEGIN_IOS_QA_FINDINGS
[
  {
    "flow_id": "${targetFlowId}",
    "status": "failed",
    "symptom": "Continue spinner forever",
    "severity": "P1",
    "repro": "1. Sign in. 2. Enter creds. 3. Tap Continue.",
    "likely_area": "Auth/SignIn.swift",
    "confidence": 0.88,
    "evidence": {
      "device_log_excerpt": "401 expired refresh"
    }
  }
]
END_IOS_QA_FINDINGS
`,
    };
    const factory = (kind: 'claude' | 'codex'): MockRunner => new MockRunner(kind, recipe);

    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      taskId: `flow:${targetFlowId}`,
      runnerFactory: factory,
    });

    expect(result.finalState).toBe('done');
    expect(result.runId).not.toBe('');

    const flows = listFlows(repoId);
    const target = flows.find((f) => f.flowId === targetFlowId)!;
    expect(target.status).toBe('failed');
    expect(target.findingCount).toBe(1);

    // Observe mode → plan is recorded in the previews table.
    const previews = getDb()
      .prepare<[string], { payload: string }>('SELECT payload FROM previews WHERE run_id = ?')
      .all(result.runId);
    expect(previews.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(previews[0]!.payload);
    expect(payload.kind === 'issue' || payload.kind === 'comment').toBe(true);
  });

  it('records FLOW_OK as passed and emits no plan', async () => {
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');

    const recipe: MockRecipe = {
      filesToWrite: [{ path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' }],
      reasoning: `All good.

FLOW_OK: ${targetFlowId}

BEGIN_IOS_QA_FINDINGS
[]
END_IOS_QA_FINDINGS
`,
    };

    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      taskId: `flow:${targetFlowId}`,
      runnerFactory: (kind) => new MockRunner(kind, recipe),
    });
    expect(result.finalState).toBe('done');

    const target = listFlows(repoId).find((f) => f.flowId === targetFlowId)!;
    expect(target.status).toBe('passed');
    expect(target.findingCount).toBe(0);
  });

  it('throws IOS_QA_POOL_FULL when every sim slot is already claimed', async () => {
    // Manually claim each slot with a unique id so the UNIQUE index is happy.
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE qa_ios_sim_slots SET claimed_run_id = 'occupied-' || slot_index, claimed_at = ?`,
    ).run(now);

    await expect(
      runAgent({
        repoId,
        agentName: 'ios-qa-pilot',
        trigger: 'manual',
        runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'IOS_QA_POOL_FULL',
      message: expect.stringContaining('simulator pool'),
    });
  });

  it('throws IOS_QA_NOTHING_CLAIMABLE when every flow has already passed in the current cycle', async () => {
    // Pre-mark all flows as passed by running selectTask once + recording
    // a passed outcome for the claimed flow. Easiest: directly UPDATE the
    // qa_ios_flows table to status='passed'.
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    // Sync the flows registry by calling listFlows after a successful
    // selectTask path — easier to directly insert via UPDATE on the
    // flow rows once syncFlowsToRegistry has populated them.
    // We bootstrap the flow rows by running a single selectTask path
    // that completes successfully, then mark all subsequent flows passed.
    const db = getDb();
    // Force-sync by referencing the same code path the handler uses.
    const { iosQaPilotHandler } = await import('../../src/main/agents/ios-qa-pilot/index');
    const { getRepo } = await import('../../src/main/db/repos');
    const repo = getRepo(repoId)!;
    // selectTask claims one flow + a slot; release them then mark all
    // flows passed so the next run finds nothing claimable.
    const selected = await iosQaPilotHandler.selectTask({
      repo,
      defaultRunner: 'claude',
    });
    expect(selected).not.toBeNull();
    // Release everything we just claimed.
    db.prepare(
      `UPDATE qa_ios_flows SET claimed_run_id = NULL, claimed_at = NULL, status = 'passed'`,
    ).run();
    db.prepare(`UPDATE qa_ios_sim_slots SET claimed_run_id = NULL, claimed_at = NULL`).run();
    void computeFlowId; // prevent unused-import warning

    await expect(
      runAgent({
        repoId,
        agentName: 'ios-qa-pilot',
        trigger: 'manual',
        runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'IOS_QA_NOTHING_CLAIMABLE',
      hint: expect.stringContaining('Reset'),
    });
  });

  it('selectTask embeds the plan id in the task ref so Mission Control can show the plan tab', async () => {
    const { iosQaPilotHandler } = await import('../../src/main/agents/ios-qa-pilot/index');
    const { getRepo } = await import('../../src/main/db/repos');
    const repo = getRepo(repoId)!;
    const selected = await iosQaPilotHandler.selectTask({ repo, defaultRunner: 'claude' });
    expect(selected).not.toBeNull();
    // ref shape: ios-qa:<flow_id>:<temp_run_id>:plan:<plan_id>
    expect(selected!.task.ref).toMatch(/^ios-qa:[^:]+:[^:]+:plan:[^:]+$/);
    // The plan id matches the seeded test plan (helper writes `full-app`).
    expect(selected!.task.ref.endsWith(':plan:full-app')).toBe(true);
  });

  it('interpretResult writes qa/ios-pilot-memory.md when the agent emits BEGIN_IOS_MEMORY_UPDATE', async () => {
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');
    const recipe: MockRecipe = {
      filesToWrite: [{ path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' }],
      reasoning: `Drove the flow.

FLOW_OK: ${targetFlowId}

BEGIN_IOS_MEMORY_UPDATE
## App architecture
- Tab bar has 4 tabs: Home, School, Profile, Library

## Useful selectors
- Login CTA: \`accessibility id = cta-login\`
END_IOS_MEMORY_UPDATE
`,
    };
    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) => new MockRunner(kind, recipe),
    });
    expect(result.runId).toBeDefined();
    const memPath = join(repoPath, 'qa', 'ios-pilot-memory.md');
    const fs = await import('node:fs');
    expect(fs.existsSync(memPath)).toBe(true);
    const body = fs.readFileSync(memPath, 'utf8');
    expect(body).toContain('Tab bar has 4 tabs');
    expect(body).toContain('Login CTA');
  });

  it('auto-detects structural defects (text cutoff, tap-target, etc.) from BEGIN_IOS_SCREEN_SNAPSHOT blocks', async () => {
    // The agent dumps XCUI source per screen; the orchestrator runs
    // deterministic rules over it and emits findings without burning
    // any LLM tokens. This is what saves the user's wallet AND
    // catches defects the LLM would miss.
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');
    const recipe: MockRecipe = {
      filesToWrite: [{ path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' }],
      reasoning: `Drove the flow.

BEGIN_IOS_SCREEN_SNAPSHOT screen_id=home
# screenshot=obelisk-evidence/${targetFlowId}/home.png
<XCUIElementTypeApplication name="MyApp" enabled="true" visible="true" x="0" y="0" width="390" height="844">
  <XCUIElementTypeButton name="X" enabled="true" visible="true" x="10" y="10" width="30" height="30"/>
  <XCUIElementTypeStaticText name="Welcome to your first lesson" enabled="true" visible="true" x="200" y="50" width="300" height="20"/>
</XCUIElementTypeApplication>
END_IOS_SCREEN_SNAPSHOT

FLOW_OK: ${targetFlowId}

BEGIN_IOS_QA_FINDINGS
[]
END_IOS_QA_FINDINGS
`,
    };

    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) => new MockRunner(kind, recipe),
    });
    expect(result.runId).toBeDefined();

    // Two structural defects expected: tap-target-too-small (30×30
    // button) + text-cutoff (StaticText overflows parent right edge).
    const db = getDb();
    const rows = db
      .prepare<
        [string],
        { kind: string; payload: string }
      >(`SELECT kind, payload FROM audit_log WHERE run_id = ? AND kind = 'ios_qa_finding'`)
      .all(result.runId!);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Auto-detected findings tag the audit row with severity from the rule.
    const detectAudit = db
      .prepare<
        [string],
        { payload: string }
      >(`SELECT payload FROM audit_log WHERE run_id = ? AND kind = 'ios_qa_auto_detect'`)
      .get(result.runId!);
    expect(detectAudit).toBeDefined();
    const auto = JSON.parse(detectAudit!.payload) as {
      screens: number;
      structural_defects: number;
    };
    expect(auto.screens).toBe(1);
    expect(auto.structural_defects).toBeGreaterThanOrEqual(2);
  });

  it('keeps visual findings at confidence 0.65 (visual floor 0.6) but drops functional findings at 0.65 (functional floor 0.7)', async () => {
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');
    const recipe: MockRecipe = {
      filesToWrite: [{ path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' }],
      reasoning: `Drove the flow.

BEGIN_IOS_QA_FINDINGS
[
  {
    "flow_id": "${targetFlowId}",
    "status": "failed",
    "category": "visual",
    "symptom": "Lesson title cut off on Home tab.",
    "severity": "P1",
    "repro": "1. Land on Home. 2. Look at top card.",
    "likely_area": "Home/LessonCard.swift",
    "confidence": 0.65,
    "evidence": { "screenshots": ["obelisk-evidence/home.png"] }
  },
  {
    "flow_id": "${targetFlowId}",
    "status": "failed",
    "category": "functional",
    "symptom": "Sign in button does nothing.",
    "severity": "P1",
    "repro": "1. Open sign-in. 2. Tap.",
    "likely_area": "Auth/SignIn.swift",
    "confidence": 0.65,
    "evidence": { "screenshots": ["obelisk-evidence/signin.png"] }
  }
]
END_IOS_QA_FINDINGS
`,
    };
    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) => new MockRunner(kind, recipe),
    });
    expect(result.runId).toBeDefined();
    // The visual finding survives the 0.6 floor; the functional finding
    // does not survive the 0.7 floor. We verify by checking the audit
    // log for the published finding(s): only one ios_qa_finding row.
    const db = getDb();
    const rows = db
      .prepare<
        [string],
        { kind: string; payload: string }
      >(`SELECT kind, payload FROM audit_log WHERE run_id = ? AND kind = 'ios_qa_finding'`)
      .all(result.runId!);
    expect(rows.length).toBe(1);
    // The surviving one is the visual finding.
    const payload = JSON.parse(rows[0]!.payload) as { plan_kind?: string; severity?: string };
    expect(payload).toBeDefined();
  });
});
