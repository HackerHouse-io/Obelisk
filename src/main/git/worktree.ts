import { app } from 'electron';
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { simpleGit } from 'simple-git';
import { ObeliskError } from '../../shared/errors';

type Git = ReturnType<typeof simpleGit>;

/**
 * Gitignored dependency directories to symlink from the main checkout into a
 * fresh worktree. Without these the agent CANNOT run the project's test/build
 * commands — `vitest` dies with "Cannot find module 'vitest/config'", pytest
 * has no venv — so Bug Fixer can't prove its fix and PR Reviewer can't verify
 * the diff. Symlinks are instant and disk-cheap (vs `npm install` per run);
 * they're gitignored so they never leak into a commit. Covers the common
 * Node + Python layouts, at the repo root and the usual monorepo subdirs.
 */
const DEPENDENCY_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  'backend/venv',
  'backend/.venv',
  'frontend/node_modules',
  'web/node_modules',
  'app/node_modules',
];

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Symlink dependency dirs from the source checkout into a new worktree so the
 * agent can run the real test/build suite. Best-effort: a failed link must
 * never fail the run (the agent just won't be able to run that toolchain).
 */
export function linkWorktreeDependencies(repoPath: string, worktreeDir: string): void {
  for (const rel of DEPENDENCY_DIRS) {
    try {
      const src = join(repoPath, rel);
      if (!existsSync(src)) continue;
      const dest = join(worktreeDir, rel);
      // Don't clobber a real (tracked) dir or an existing link.
      if (existsSync(dest) || isSymlink(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(src, dest, 'junction');
    } catch {
      // Best-effort — a missing dependency link is not fatal.
    }
  }
}

/**
 * Serialize git worktree mutations per repo. PR Reviewer is multiInstance
 * with no per-repo cap, so two runs touching the same repo can otherwise
 * race `git worktree add/remove/prune` concurrently — one operation taking
 * git's worktree lock mid-`list` is the most plausible trigger for the
 * "already used by worktree" failures the reclaim path then can't recover
 * from. Chaining every mutation through a per-repoPath promise removes the
 * race entirely. In-memory only; the set of repos is small and bounded.
 */
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Anchor the chain on a non-rejecting tail so one failure doesn't poison
  // every subsequent caller for this repo.
  repoLocks.set(
    repoPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Run `git worktree add <args>`, recovering from a branch/worktree collision.
 *
 * The recovery is deliberately belt-and-suspenders because a single failure
 * here fails the whole run with no agent output:
 *  - The colliding holder is taken from git's OWN error message
 *    (`already used by worktree at '<path>'`) — authoritative and works even
 *    when `git worktree list` transiently fails — falling back to listing.
 *  - `canReclaimHolder` lets the caller refuse to steal a LIVE run's worktree
 *    (→ `WORKTREE_BUSY`) instead of clobbering an in-flight run.
 *  - It retries in a bounded loop rather than once, and clears a dangling
 *    local branch ref when no worktree actually holds it.
 */
async function addWorktreeReclaiming(
  git: Git,
  addArgs: string[],
  branch: string,
  canReclaimHolder?: CanReclaimHolder,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await git.raw(['worktree', ...addArgs]);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isCollision = /already (checked out|used by worktree)/i.test(message);
      const branchExists = /a branch named '[^']+' already exists/i.test(message);
      if ((!isCollision && !branchExists) || attempt >= MAX_ATTEMPTS) throw e;

      if (isCollision) {
        // Prefer the path git named in the error; fall back to listing.
        const fromMessage = /already used by worktree at '([^']+)'/i.exec(message)?.[1] ?? null;
        const holder = fromMessage ?? (await findWorktreeForBranch(git, branch));
        if (!holder) {
          // No worktree actually holds the branch — the ref is just wedged.
          // Prune and retry.
          await git.raw(['worktree', 'prune']).catch(() => undefined);
          continue;
        }
        if (canReclaimHolder && !canReclaimHolder(holder)) {
          throw new ObeliskError(
            'WORKTREE_BUSY',
            `branch ${branch} is checked out by a live run at ${holder}`,
            'Wait for the in-flight run to finish, then retry.',
          );
        }
        await git.raw(['worktree', 'remove', '--force', holder]).catch(() => undefined);
        if (existsSync(holder)) rmSync(holder, { recursive: true, force: true });
        await git.raw(['worktree', 'prune']).catch(() => undefined);
        continue;
      }

      // branchExists but no worktree holds it: drop the dangling local branch
      // so the add can recreate / check it out, then retry.
      await git.raw(['branch', '-D', branch]).catch(() => undefined);
      await git.raw(['worktree', 'prune']).catch(() => undefined);
    }
  }
}

/**
 * Optional predicate the orchestrator injects so the reclaim path never
 * yanks a worktree out from under a LIVE run. Given the colliding holder's
 * directory, return `false` to refuse the steal (we then surface a clean
 * `WORKTREE_BUSY` instead of clobbering an in-flight run). Defaults to
 * "always reclaimable" for callers that don't care (tests, CI-resume).
 */
export type CanReclaimHolder = (holderPath: string) => boolean;

export interface CreateWorktreeInput {
  /** Source repo's local clone path. */
  repoPath: string;
  /** Stable id for the repo (used to namespace the worktree directory). */
  repoId: string;
  /** Stable id for this run (the worktree directory name + branch suffix). */
  runId: string;
  /** Branch to fork from. Usually `repos.default_branch`. */
  baseBranch: string;
  /** See {@link CanReclaimHolder}. */
  canReclaimHolder?: CanReclaimHolder;
}

export interface WorktreeHandle {
  worktreePath: string;
  branch: string;
  /**
   * Where the new branch was forked from. `origin` means we successfully
   * fetched + branched off `origin/<baseBranch>` (the right behaviour);
   * `local` means the fetch failed and we fell back to the local ref.
   * Callers can audit / warn when basedOn === 'local' so a stale-base
   * PR isn't silent.
   */
  basedOn?: 'origin' | 'local';
}

/**
 * Create an isolated git worktree at <userData>/worktrees/<repoId>/<runId>/
 * branched from baseBranch. The worktree is the runner's `cwd`; it is
 * destroyed after the run unless the run failed (debug retention).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeHandle> {
  return withRepoLock(input.repoPath, async () => {
    const root = worktreesRoot();
    const dir = join(root, input.repoId, input.runId);
    const git = simpleGit(input.repoPath);

    // The dir name is the (unique) run id, so a leftover here is a reaped /
    // half-cleaned worktree from a crash, not a genuine collision. Self-heal
    // rather than hard-fail the run: drop git's registration and the files.
    if (existsSync(dir)) {
      await git.raw(['worktree', 'remove', '--force', dir]).catch(() => undefined);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      await git.raw(['worktree', 'prune']).catch(() => undefined);
    }
    mkdirSync(join(root, input.repoId), { recursive: true });

    const branch = `obelisk/${input.runId}`;

    // We branch off `origin/<baseBranch>`, NOT the local ref, because the
    // user's local `main` is often days behind the remote — branching off
    // it produced PRs with merge conflicts before this fix even hit the
    // first commit. Fetch the remote ref synchronously, fall back to the
    // local ref only if the fetch errors (no network, missing remote).
    let base = input.baseBranch;
    let usedOrigin = false;
    try {
      await git.fetch('origin', input.baseBranch);
      // Verify origin/<baseBranch> actually exists locally now. simple-git
      // returns void on success; we test the ref directly.
      await git.raw(['rev-parse', '--verify', `origin/${input.baseBranch}`]);
      base = `origin/${input.baseBranch}`;
      usedOrigin = true;
    } catch {
      // No remote / no network / detached HEAD — fall through to the local
      // base. Worktree creation still succeeds; the run may produce a
      // stale PR but at least it doesn't fail at this step.
    }

    // `git worktree add -b <new-branch> <path> <base>` creates the new
    // branch from <base> and checks it out into the new worktree.
    await addWorktreeReclaiming(
      git,
      ['add', '-b', branch, dir, base],
      branch,
      input.canReclaimHolder,
    );

    linkWorktreeDependencies(input.repoPath, dir);
    return { worktreePath: dir, branch, basedOn: usedOrigin ? 'origin' : 'local' };
  });
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
  /** See {@link CanReclaimHolder}. */
  canReclaimHolder?: CanReclaimHolder;
}

/**
 * Attach a worktree to an EXISTING remote branch (vs `createWorktree`, which
 * creates a fresh branch off a base). Used for the CI-retry resume flow:
 * the new run pushes a fix-up commit to the same branch the original PR is
 * tracking, so GitHub auto-attaches the commit to the PR.
 */
export async function attachWorktree(input: AttachWorktreeInput): Promise<WorktreeHandle> {
  return withRepoLock(input.repoPath, async () => {
    const root = worktreesRoot();
    const dir = join(root, input.repoId, input.slot);
    const git = simpleGit(input.repoPath);

    // The slot is unique per run, so a leftover dir is a reaped/crashed
    // worktree — self-heal rather than fail the run.
    if (existsSync(dir)) {
      await git.raw(['worktree', 'remove', '--force', dir]).catch(() => undefined);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      await git.raw(['worktree', 'prune']).catch(() => undefined);
    }
    mkdirSync(join(root, input.repoId), { recursive: true });

    // `git worktree add <path> <branch>` checks out the existing branch into
    // the new worktree without creating a new local branch. Fetching first
    // ensures the local ref matches origin so the agent sees the latest tip.
    await git.fetch('origin', input.branch).catch(() => undefined);

    // Prune worktree entries whose directories were already deleted (e.g. a
    // prior failed run's worktree dir was reaped from disk but git still has
    // it registered). Cheap and idempotent.
    await git.raw(['worktree', 'prune']).catch(() => undefined);

    // The branch may already be checked out by a terminal run's retained
    // worktree (24h debug window). addWorktreeReclaiming reclaims it — but
    // refuses to steal a LIVE run's worktree via canReclaimHolder.
    await addWorktreeReclaiming(
      git,
      ['add', dir, input.branch],
      input.branch,
      input.canReclaimHolder,
    );

    linkWorktreeDependencies(input.repoPath, dir);
    return { worktreePath: dir, branch: input.branch };
  });
}

/**
 * Find the path of the existing worktree that has `branch` checked out.
 * Returns null when no worktree holds the branch (the collision was something
 * else, e.g. a bare ref lock).
 */
async function findWorktreeForBranch(git: Git, branch: string): Promise<string | null> {
  const raw = await git.raw(['worktree', 'list', '--porcelain']).catch(() => '');
  return parseWorktreeList(raw).find((w) => w.branch === branch)?.path ?? null;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

/**
 * Parse `git worktree list --porcelain` output. Each block is:
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 * Blocks are separated by blank lines; the `refs/heads/` prefix is stripped.
 * Blocks without a branch (detached HEAD) are skipped.
 */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = (): void => {
    if (current.path && current.branch) out.push({ path: current.path, branch: current.branch });
    current = {};
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  flush();
  return out;
}

export async function destroyWorktree(repoPath: string, worktreePath: string): Promise<void> {
  return withRepoLock(repoPath, async () => {
    const git = simpleGit(repoPath);
    // Best-effort: `worktree remove` complains about uncommitted changes;
    // we always force-remove because the worktree is per-run scratch.
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    // Belt-and-suspenders: if `worktree remove` failed, nuke the dir.
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
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
