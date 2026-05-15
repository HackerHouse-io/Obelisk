import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { createBacklogItem } from '../../src/main/db/backlog';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { bugFixerHandler } from '../../src/main/agents/bug-fixer';
import type { Repo } from '../../src/shared/types';

const issuesGet = vi.fn();
const fakeGh = {
  issues: {
    get: issuesGet,
    listForRepo: vi.fn(async () => ({ data: [] })),
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    addAssignees: vi.fn().mockResolvedValue({ data: {} }),
    removeAssignees: vi.fn().mockResolvedValue({ data: {} }),
  },
};
vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));
vi.mock('../../src/main/auth/token-store', () => ({
  getAuthedLogin: vi.fn(async () => 'obelisk-test-user'),
  getStoredToken: vi.fn(async () => null),
}));

let tmpRoot: string;
let repoPath: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-bf-diag-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

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

  issuesGet.mockReset();
  fakeGh.issues.listForRepo.mockReset();
  fakeGh.issues.listForRepo.mockResolvedValue({ data: [] });
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRepo(): Repo {
  return createRepo({
    githubFullName: 'test/diag',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
}

describe('bug-fixer manual Run-now: diagnostic fallback message', () => {
  it('reports "all in flight" when every local bug row is locked by a live run', async () => {
    const repo = makeRepo();
    const agent = createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    // Two local bug rows, both locked by live runs (queued/running).
    const a = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Bug A',
      kind: 'bug',
    });
    const b = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Bug B',
      kind: 'bug',
    });
    const r1 = createRun({
      repoId: repo.id,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'backlog#a',
      runnerUsed: 'claude',
    });
    const r2 = createRun({
      repoId: repo.id,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'backlog#b',
      runnerUsed: 'claude',
    });
    transitionRun(r2.id, 'running');
    getDb()
      .prepare('UPDATE backlog SET in_progress_run = ? WHERE id = ?')
      .run(r1.id, a.id);
    getDb()
      .prepare('UPDATE backlog SET in_progress_run = ? WHERE id = ?')
      .run(r2.id, b.id);

    await expect(
      bugFixerHandler.selectTask({ repo, defaultRunner: 'claude', trigger: 'manual' }),
    ).rejects.toMatchObject({
      code: 'BACKLOG_ALL_FILTERED',
      message: expect.stringMatching(/2 `obelisk:fix` issues in the local backlog are already in flight/),
      hint: expect.stringMatching(/Wait for a run to finish/),
    });
  });

  it('clears stale locks before claiming, so a freshly orphaned row is reusable on Run-now', async () => {
    const repo = makeRepo();
    const agent = createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    // Backlog row + a run that finished but left the lock behind (process
    // crash skipped the orchestrator's finally-unlock).
    const item = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Stale-locked bug',
      kind: 'bug',
    });
    const orphanRun = createRun({
      repoId: repo.id,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'backlog#orphan',
      runnerUsed: 'claude',
    });
    transitionRun(orphanRun.id, 'failed');
    getDb()
      .prepare('UPDATE backlog SET in_progress_run = ? WHERE id = ?')
      .run(orphanRun.id, item.id);

    const selected = await bugFixerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'manual',
    });
    expect(selected).not.toBeNull();
    expect(selected?.backlogItem.id).toBe(item.id);
  });
});
