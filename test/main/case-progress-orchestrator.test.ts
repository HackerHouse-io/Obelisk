import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { runAgent } from '../../src/main/orchestrator/run';
import { addInProcessListener } from '../../src/main/ipc/bus';
import { seedTestPlanFile } from '../helpers/seed-plan';
import { clearActiveRunsForTesting } from '../../src/main/orchestrator/active-runs';
import type { BusEvent } from '../../src/shared/types';
import type { CodingAgentRunner, RunOpts, RunResult } from '../../src/main/runners/types';

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;

function buildOutput(idA: string, idB: string): string {
  return `Looking at the plan…

CASE_START ${idA}
Investigating…
CASE_PASS ${idA}
CASE_START ${idB}
A bug here.
CASE_FAIL ${idB}

BEGIN_FINDINGS
[]
END_FINDINGS
`;
}

class StreamingMockRunner implements CodingAgentRunner {
  readonly kind: 'claude' | 'codex' = 'claude';
  constructor(private readonly output: string) {}
  async isInstalled() {
    return { ok: true as const, version: 'mock-1.0' };
  }
  async run(opts: RunOpts, _abort: AbortSignal): Promise<RunResult> {
    // Stream the sample output one line at a time so the orchestrator's
    // case-progress tracker sees each marker.
    for (const line of this.output.split('\n')) {
      opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
    }
    return {
      ok: false,
      reason: 'no_changes',
      detail: 'mock no-diff',
      reasoning: this.output,
    };
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-case-progress-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
  clearActiveRunsForTesting();

  repoPath = join(tmpRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('case-progress: orchestrator wiring', () => {
  it('streams in-plan CASE_* markers as case_progress audit rows + run.caseProgress bus events', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    const seeded = seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });
    const [idA, idB] = seeded.caseIds;
    if (!idA || !idB) throw new Error('seedTestPlanFile should return at least 2 case ids');
    const output = buildOutput(idA, idB);

    const captured: BusEvent[] = [];
    const unsubscribe = addInProcessListener((evt) => captured.push(evt));

    try {
      const result = await runAgent({
        repoId: repo.id,
        agentName: 'qa-hunter',
        trigger: 'manual',
        runnerFactory: () => new StreamingMockRunner(output),
      });
      expect(result.finalState).toBe('done');

      const auditRows = getDb()
        .prepare<
          [string, string],
          { payload: string }
        >('SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?')
        .all(result.runId, 'case_progress');
      const events = auditRows.map(
        (r) => JSON.parse(r.payload) as { caseId: string; status: string },
      );
      expect(events).toEqual([
        { caseId: idA, status: 'running' },
        { caseId: idA, status: 'passed' },
        { caseId: idB, status: 'running' },
        { caseId: idB, status: 'failed' },
      ]);

      // No orphans expected — every marker matched a plan case.
      const orphanRows = getDb()
        .prepare<
          [string, string],
          { payload: string }
        >('SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?')
        .all(result.runId, 'case_progress_orphan');
      expect(orphanRows).toEqual([]);

      const busProgress = captured
        .filter(
          (e): e is Extract<BusEvent, { type: 'run.caseProgress' }> =>
            e.type === 'run.caseProgress',
        )
        .filter((e) => e.runId === result.runId)
        .map((e) => ({ caseId: e.caseId, status: e.status }));
      expect(busProgress).toEqual([
        { caseId: idA, status: 'running' },
        { caseId: idA, status: 'passed' },
        { caseId: idB, status: 'running' },
        { caseId: idB, status: 'failed' },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('diverts CASE_* markers whose ids are not in the assigned plan into case_progress_orphan rows', async () => {
    // Reproduces the screenshot bug source: an agent that echoed
    // synthetic / wrong case ids instead of the plan's ULIDs.
    // Pre-fix those markers landed in `case_progress`, inflating the
    // Plan tab's counts; now they land in `case_progress_orphan` and
    // the Plan tab surfaces them as an "untracked markers" footnote.
    const repo = createRepo({
      githubFullName: 'test/y',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });
    const output = buildOutput('not-in-plan-A', 'not-in-plan-B');

    const captured: BusEvent[] = [];
    const unsubscribe = addInProcessListener((evt) => captured.push(evt));

    try {
      const result = await runAgent({
        repoId: repo.id,
        agentName: 'qa-hunter',
        trigger: 'manual',
        runnerFactory: () => new StreamingMockRunner(output),
      });
      expect(result.finalState).toBe('done');

      const orphanRows = getDb()
        .prepare<
          [string, string],
          { payload: string }
        >('SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?')
        .all(result.runId, 'case_progress_orphan');
      const orphanEvents = orphanRows.map(
        (r) => JSON.parse(r.payload) as { caseId: string; status: string },
      );
      expect(orphanEvents).toEqual([
        { caseId: 'not-in-plan-A', status: 'running' },
        { caseId: 'not-in-plan-A', status: 'passed' },
        { caseId: 'not-in-plan-B', status: 'running' },
        { caseId: 'not-in-plan-B', status: 'failed' },
      ]);

      // No in-plan case_progress rows for this run.
      const inPlanRows = getDb()
        .prepare<
          [string, string],
          { payload: string }
        >('SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?')
        .all(result.runId, 'case_progress');
      expect(inPlanRows).toEqual([]);

      // Orphans do NOT broadcast — keeps the live Plan tab subscription
      // free of phantom updates.
      const busProgress = captured
        .filter(
          (e): e is Extract<BusEvent, { type: 'run.caseProgress' }> =>
            e.type === 'run.caseProgress',
        )
        .filter((e) => e.runId === result.runId);
      expect(busProgress).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
