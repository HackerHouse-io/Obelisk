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
import {
  listFlows,
  setSetupAt,
  upsertSimSlot,
} from '../../src/main/db/qa-flows';
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
  it('selects no task when Doctor has not run', async () => {
    setSetupAt(repoId, null);
    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
    });
    expect(result.runId).toBe('');
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
      filesToWrite: [
        { path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' },
      ],
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

    // Observe mode → plan is recorded as a 'preview' audit row.
    const previews = getDb()
      .prepare<[string], { kind: string; payload: string }>(
        'SELECT kind, payload FROM audit_log WHERE run_id = ? AND kind = ?',
      )
      .all(result.runId, 'preview');
    expect(previews.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(previews[0]!.payload);
    expect(payload.kind === 'issue' || payload.kind === 'comment').toBe(true);
  });

  it('records FLOW_OK as passed and emits no plan', async () => {
    const { computeFlowId } = await import('../../src/main/agents/ios-qa-pilot/flows');
    const targetFlowId = computeFlowId('qa/ios-flows/login.flow.md', 'Login happy path');

    const recipe: MockRecipe = {
      filesToWrite: [
        { path: 'obelisk-evidence/marker.txt', contents: 'flow run marker' },
      ],
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

  it('returns no run when sim pool is exhausted', async () => {
    // Manually claim each slot with a unique id so the UNIQUE index is happy.
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE qa_ios_sim_slots SET claimed_run_id = 'occupied-' || slot_index, claimed_at = ?`,
    ).run(now);

    const result = await runAgent({
      repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
      runnerFactory: (kind) => new MockRunner(kind, { filesToWrite: [] }),
    });
    expect(result.runId).toBe('');
  });
});
