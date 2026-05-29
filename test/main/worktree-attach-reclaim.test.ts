import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

// worktree.ts asks electron for the userData dir to root its worktrees under.
// In the node test env we point it at a temp dir we control + clean up, so
// the real `git worktree add` calls don't pollute the project tree.
const { WT_BASE } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return { WT_BASE: path.join(os.tmpdir(), `obelisk-wt-base-${process.pid}`) };
});
vi.mock('electron', () => ({ app: { getPath: () => WT_BASE } }));

import { attachWorktree } from '../../src/main/git/worktree';

let repoDir: string;
const repoId = 'wt-reclaim-repo';

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'obelisk-wt-src-'));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.raw(['checkout', '-b', 'main']);
  await git.raw(['commit', '--allow-empty', '-m', 'init']);
  // The PR's head branch the reviewer attaches to in fix mode.
  await git.raw(['branch', 'pr-branch']);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(join(WT_BASE, 'worktrees', repoId), { recursive: true, force: true });
});

describe('attachWorktree', () => {
  it('attaches a worktree to an existing branch', async () => {
    const h = await attachWorktree({ repoPath: repoDir, repoId, slot: 'slot-a', branch: 'pr-branch' });
    expect(existsSync(h.worktreePath)).toBe(true);
    expect(h.branch).toBe('pr-branch');
  });

  it('reclaims a stale worktree holding the branch instead of failing', async () => {
    // First attach simulates a prior failed run that RETAINED its worktree on
    // the PR branch (run.ts only destroys worktrees on success).
    const first = await attachWorktree({
      repoPath: repoDir,
      repoId,
      slot: 'slot-old',
      branch: 'pr-branch',
    });
    expect(existsSync(first.worktreePath)).toBe(true);

    // The retry must NOT die with "branch already checked out" — it should
    // reclaim the stale worktree and succeed.
    const second = await attachWorktree({
      repoPath: repoDir,
      repoId,
      slot: 'slot-new',
      branch: 'pr-branch',
    });
    expect(existsSync(second.worktreePath)).toBe(true);
    expect(second.branch).toBe('pr-branch');
    // The stale worktree was removed during reclaim.
    expect(existsSync(first.worktreePath)).toBe(false);
  });
});
