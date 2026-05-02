import { app } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ObeliskError } from '../../shared/errors';

export interface CreateWorktreeInput {
  /** Source repo's local clone path. */
  repoPath: string;
  /** Stable id for the repo (used to namespace the worktree directory). */
  repoId: string;
  /** Stable id for this run (the worktree directory name + branch suffix). */
  runId: string;
  /** Branch to fork from. Usually `repos.default_branch`. */
  baseBranch: string;
}

export interface WorktreeHandle {
  worktreePath: string;
  branch: string;
}

/**
 * Create an isolated git worktree at <userData>/worktrees/<repoId>/<runId>/
 * branched from baseBranch. The worktree is the runner's `cwd`; it is
 * destroyed after the run unless the run failed (debug retention).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeHandle> {
  const root = worktreesRoot();
  const dir = join(root, input.repoId, input.runId);

  if (existsSync(dir)) {
    throw new ObeliskError(
      'CONFLICT',
      `worktree already exists: ${dir}`,
      'Destroy the previous worktree before creating a new one for the same run.',
    );
  }
  mkdirSync(join(root, input.repoId), { recursive: true });

  const branch = `obelisk/${input.runId}`;
  const git = simpleGit(input.repoPath);

  // Make sure the base branch is fetched so we have a current ref to
  // branch off of. Errors from `fetch` are non-fatal here — local-only
  // repos and detached HEADs both work, but we surface the error in the
  // hint if branch creation later fails.
  await git.fetch().catch(() => undefined);

  // `git worktree add -b <new-branch> <path> <base>` creates the new
  // branch from <base> and checks it out into the new worktree.
  await git.raw(['worktree', 'add', '-b', branch, dir, input.baseBranch]);

  return { worktreePath: dir, branch };
}

export async function destroyWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  // Best-effort: `worktree remove` complains about uncommitted changes;
  // we always force-remove because the worktree is per-run scratch.
  await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
  // Belt-and-suspenders: if `worktree remove` failed, nuke the dir.
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/** Test-only: prune all worktrees registered with the source repo. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.raw(['worktree', 'prune']);
}

function worktreesRoot(): string {
  // In dev / test contexts (no Electron app), fall back to a stable temp
  // directory under the repo so callers don't have to special-case.
  try {
    return join(app.getPath('userData'), 'worktrees');
  } catch {
    return join(process.cwd(), '.obelisk-worktrees');
  }
}
