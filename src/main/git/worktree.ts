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

export interface AttachWorktreeInput {
  /** Source repo's local clone path. */
  repoPath: string;
  /** Stable id for the repo (used to namespace the worktree directory). */
  repoId: string;
  /**
   * Slot id used as the worktree directory name. CI-retry callers pass
   * something like `<runId>-ci-retry-<timestamp>` so it doesn't collide with
   * the original run's reaped (or live) worktree.
   */
  slot: string;
  /** Existing remote branch to check out (e.g. an open PR's head ref). */
  branch: string;
}

/**
 * Attach a worktree to an EXISTING remote branch (vs `createWorktree`, which
 * creates a fresh branch off a base). Used for the CI-retry resume flow:
 * the new run pushes a fix-up commit to the same branch the original PR is
 * tracking, so GitHub auto-attaches the commit to the PR.
 */
export async function attachWorktree(input: AttachWorktreeInput): Promise<WorktreeHandle> {
  const root = worktreesRoot();
  const dir = join(root, input.repoId, input.slot);

  if (existsSync(dir)) {
    throw new ObeliskError(
      'CONFLICT',
      `worktree already exists: ${dir}`,
      'Pick a fresh slot id; attachWorktree refuses to clobber an existing dir.',
    );
  }
  mkdirSync(join(root, input.repoId), { recursive: true });

  const git = simpleGit(input.repoPath);
  // `git worktree add <path> <branch>` checks out the existing branch into
  // the new worktree without creating a new local branch. Fetching first
  // ensures the local ref matches origin so the agent sees the latest tip.
  await git.fetch('origin', input.branch).catch(() => undefined);
  await git.raw(['worktree', 'add', dir, input.branch]);

  return { worktreePath: dir, branch: input.branch };
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
