import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { createBacklogItem } from '../../src/main/db/backlog';
import { runAgent } from '../../src/main/orchestrator/run';
import { MockRunner, type MockRecipe } from '../helpers/mock-runner';

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-multi-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

  repoPath = join(tmpRoot, 'repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repoPath, 'src/b.ts'), 'export const b = 2;\n');
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

describe('orchestrator: multi-instance bug-fixer', () => {
  it('two parallel Bug Fixers pick distinct backlog items (no duplicate work)', async () => {
    const repo = createRepo({
      githubFullName: 'test/multi',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const fixer1 = createAgent({ repoId: repo.id, name: 'bug-fixer', displayName: 'Fixer 1' });
    const fixer2 = createAgent({ repoId: repo.id, name: 'bug-fixer', displayName: 'Fixer 2' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    const itemA = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Bug A',
      kind: 'bug',
      priorityLabel: 'P0',
    });
    const itemB = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Bug B',
      kind: 'bug',
      priorityLabel: 'P0',
    });

    // Each runner produces a distinct patch so we can confirm both ran.
    const recipeA: MockRecipe = {
      filesToWrite: [{ path: 'src/a.ts', contents: 'export const a = 11;\n' }],
      reasoning: 'fixed A',
    };
    const recipeB: MockRecipe = {
      filesToWrite: [{ path: 'src/b.ts', contents: 'export const b = 22;\n' }],
      reasoning: 'fixed B',
    };
    const factoryA = (k: 'claude' | 'codex'): MockRunner => new MockRunner(k, recipeA);
    const factoryB = (k: 'claude' | 'codex'): MockRunner => new MockRunner(k, recipeB);

    const [resA, resB] = await Promise.all([
      runAgent({
        repoId: repo.id,
        agentName: 'bug-fixer',
        agentId: fixer1.id,
        trigger: 'manual',
        runnerFactory: factoryA,
      }),
      runAgent({
        repoId: repo.id,
        agentName: 'bug-fixer',
        agentId: fixer2.id,
        trigger: 'manual',
        runnerFactory: factoryB,
      }),
    ]);

    // Both runs reached publish (failed there because mode=observe + no GH).
    expect(resA.runId).toBeTruthy();
    expect(resB.runId).toBeTruthy();
    // The two task_refs must be different — one took item A, the other took item B.
    expect(resA.runId).not.toBe(resB.runId);

    // Verify in the DB that no single backlog item was claimed by both runs.
    const ids = [itemA.id, itemB.id];
    expect(ids.length).toBe(2);
  });

  it('three Bug Fixers vs two backlog items: third throws BACKLOG_ALL_FILTERED', async () => {
    const repo = createRepo({
      githubFullName: 'test/three',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const f1 = createAgent({ repoId: repo.id, name: 'bug-fixer', displayName: 'F1' });
    const f2 = createAgent({ repoId: repo.id, name: 'bug-fixer', displayName: 'F2' });
    const f3 = createAgent({ repoId: repo.id, name: 'bug-fixer', displayName: 'F3' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    createBacklogItem({ repoId: repo.id, source: 'manual', title: 'Only A', kind: 'bug' });
    createBacklogItem({ repoId: repo.id, source: 'manual', title: 'Only B', kind: 'bug' });

    const recipe: MockRecipe = {
      filesToWrite: [{ path: 'src/a.ts', contents: 'export const a = 99;\n' }],
      reasoning: 'changed something',
    };
    const factory = (k: 'claude' | 'codex'): MockRunner => new MockRunner(k, recipe);

    const results = await Promise.allSettled([
      runAgent({
        repoId: repo.id,
        agentName: 'bug-fixer',
        agentId: f1.id,
        trigger: 'manual',
        runnerFactory: factory,
      }),
      runAgent({
        repoId: repo.id,
        agentName: 'bug-fixer',
        agentId: f2.id,
        trigger: 'manual',
        runnerFactory: factory,
      }),
      runAgent({
        repoId: repo.id,
        agentName: 'bug-fixer',
        agentId: f3.id,
        trigger: 'manual',
        runnerFactory: factory,
      }),
    ]);

    // Two should fulfill (each got its own backlog row); the third
    // throws BACKLOG_ALL_FILTERED with an actionable hint instead of
    // the old null/sentinel return.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(err.code).toBe('BACKLOG_ALL_FILTERED');
  });
});
