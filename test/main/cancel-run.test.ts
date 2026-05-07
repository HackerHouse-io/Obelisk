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
import { handleAgentsCancel } from '../../src/main/ipc/agents';
import { seedTestPlanFile } from '../helpers/seed-plan';
import { clearActiveRunsForTesting } from '../../src/main/orchestrator/active-runs';
import type { CodingAgentRunner, RunOpts, RunResult } from '../../src/main/runners/types';

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;

class SlowMockRunner implements CodingAgentRunner {
  readonly kind: 'claude' | 'codex' = 'claude';
  async isInstalled() {
    return { ok: true as const, version: 'mock-1.0' };
  }
  // Simulates a long-running spawn that resolves only when aborted.
  async run(_opts: RunOpts, abort: AbortSignal): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const handler = (): void => {
        // Mirrors what spawnAgentCli returns when killed: empty stdout,
        // non-zero exit (or our coerced no_changes for read-only).
        resolve({
          ok: false,
          reason: 'no_changes',
          detail: 'aborted by user',
          reasoning: '',
        });
      };
      if (abort.aborted) {
        handler();
      } else {
        abort.addEventListener('abort', handler, { once: true });
      }
    });
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-cancel-'));
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

describe('agents:cancel — stop an in-flight run', () => {
  it('aborts the runner and transitions the run to cancelled (not failed)', async () => {
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

    // Kick the run off; resolve happens after abort fires.
    const runPromise = runAgent({
      repoId: repo.id,
      agentName: 'qa-hunter',
      trigger: 'manual',
      runnerFactory: () => new SlowMockRunner(),
    });

    // Wait for the orchestrator to register the run, then poll the DB for
    // the row so we can target it for cancel. Bounded loop, ~2s max.
    let runId: string | null = null;
    for (let i = 0; i < 40; i++) {
      const row = getDb()
        .prepare<[], { id: string }>("SELECT id FROM runs WHERE state = 'running' LIMIT 1")
        .get();
      if (row) {
        runId = row.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).not.toBeNull();

    // Click Stop.
    const cancelRes = await handleAgentsCancel({ runId: runId! });
    expect(cancelRes.ok).toBe(true);

    // The orchestrator should now resolve and land the run in 'cancelled'.
    const result = await runPromise;
    expect(result.finalState).toBe('cancelled');
    expect(result.reason).toBe('user_cancelled');

    const row = getDb()
      .prepare<[string], { state: string; output_summary: string | null }>(
        'SELECT state, output_summary FROM runs WHERE id = ?',
      )
      .get(runId!);
    expect(row?.state).toBe('cancelled');
    expect(row?.output_summary).toMatch(/Stopped by the user/);
  }, 30_000);

  it('cancelling an already-terminal run is a no-op (no error)', async () => {
    // Drop a run row directly in 'done' state, then try to cancel it.
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const runId = 'run-already-done';
    getDb()
      .prepare(
        `INSERT INTO runs (id, repo_id, agent_name, state, trigger, runner_used)
         VALUES (?, ?, 'qa-hunter', 'done', 'manual', 'claude')`,
      )
      .run(runId, repo.id);

    const res = await handleAgentsCancel({ runId });
    expect(res.ok).toBe(true);

    const after = getDb()
      .prepare<[string], { state: string }>('SELECT state FROM runs WHERE id = ?')
      .get(runId);
    expect(after?.state).toBe('done'); // unchanged
  });

  it('cancelling an unknown runId throws RUN_NOT_FOUND', async () => {
    await expect(handleAgentsCancel({ runId: 'no-such-run' })).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });
});
