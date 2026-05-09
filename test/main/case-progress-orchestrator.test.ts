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

const SAMPLE_OUTPUT = `Looking at the plan…

CASE_START 01H_AAA
Investigating…
CASE_PASS 01H_AAA
CASE_START 01H_BBB
A bug here.
CASE_FAIL 01H_BBB

BEGIN_FINDINGS
[]
END_FINDINGS
`;

class StreamingMockRunner implements CodingAgentRunner {
  readonly kind: 'claude' | 'codex' = 'claude';
  async isInstalled() {
    return { ok: true as const, version: 'mock-1.0' };
  }
  async run(opts: RunOpts, _abort: AbortSignal): Promise<RunResult> {
    // Stream the sample output one line at a time so the orchestrator's
    // case-progress tracker sees each marker.
    for (const line of SAMPLE_OUTPUT.split('\n')) {
      opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
    }
    return {
      ok: false,
      reason: 'no_changes',
      detail: 'mock no-diff',
      reasoning: SAMPLE_OUTPUT,
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
  it('streams CASE_* markers as audit rows + run.caseProgress bus events', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });

    const captured: BusEvent[] = [];
    const unsubscribe = addInProcessListener((evt) => captured.push(evt));

    try {
      const result = await runAgent({
        repoId: repo.id,
        agentName: 'qa-hunter',
        trigger: 'manual',
        runnerFactory: () => new StreamingMockRunner(),
      });
      expect(result.finalState).toBe('done');

      // Audit log should contain three case_progress rows.
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
        { caseId: '01H_AAA', status: 'running' },
        { caseId: '01H_AAA', status: 'passed' },
        { caseId: '01H_BBB', status: 'running' },
        { caseId: '01H_BBB', status: 'failed' },
      ]);

      // Bus broadcasts should mirror the audit rows.
      const busProgress = captured
        .filter(
          (e): e is Extract<BusEvent, { type: 'run.caseProgress' }> =>
            e.type === 'run.caseProgress',
        )
        .filter((e) => e.runId === result.runId)
        .map((e) => ({ caseId: e.caseId, status: e.status }));
      expect(busProgress).toEqual([
        { caseId: '01H_AAA', status: 'running' },
        { caseId: '01H_AAA', status: 'passed' },
        { caseId: '01H_BBB', status: 'running' },
        { caseId: '01H_BBB', status: 'failed' },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
