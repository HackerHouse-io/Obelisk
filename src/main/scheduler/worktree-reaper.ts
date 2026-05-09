import { simpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import { listRepos } from '../db/repos';
import { getRun } from '../db/runs';
import { destroyWorktree } from '../git/worktree';
import { appendAudit } from '../logger/audit';
import type { Repo } from '../../shared/types';

/** Stale-after threshold: 24h since the run finished. Mirrors run.ts:649. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep every connected repo for orphaned `obelisk/<runId>` worktrees and
 * remove the ones whose owning run is in a terminal state and finished
 * more than 24h ago. Called from the scheduler tick every ~10 minutes.
 *
 * Runs that succeed already destroy their worktree in `runAgent`'s finally
 * block; this sweep handles the failed/paused/cancelled retention window.
 *
 * Best-effort throughout — single-repo failures don't block other repos.
 */
export async function worktreeReaperSweep(): Promise<void> {
  for (const repo of listRepos()) {
    await reapRepo(repo).catch((e: unknown) => {
      console.warn(`[obelisk] worktree reaper failed for ${repo.githubFullName}:`, e);
    });
  }
}

async function reapRepo(repo: Repo): Promise<void> {
  if (!existsSync(repo.localPath)) return;
  const git = simpleGit(repo.localPath);

  let raw: string;
  try {
    raw = await git.raw(['worktree', 'list', '--porcelain']);
  } catch {
    return;
  }

  const worktrees = parseWorktreeList(raw);
  const now = Date.now();
  for (const wt of worktrees) {
    const runId = parseRunIdFromBranch(wt.branch);
    if (!runId) continue;
    const run = getRun(runId);
    if (!run) {
      // Worktree references a run that's been deleted. Reap it.
      await destroyAndAudit(repo, wt.path, runId, 'run_missing');
      continue;
    }
    if (run.state !== 'done' && run.state !== 'failed' && run.state !== 'cancelled') {
      continue;
    }
    if (!run.finishedAt) continue;
    const finished = new Date(run.finishedAt).getTime();
    if (Number.isNaN(finished)) continue;
    if (now - finished < STALE_AFTER_MS) continue;
    await destroyAndAudit(repo, wt.path, runId, run.state);
  }
}

async function destroyAndAudit(
  repo: Repo,
  worktreePath: string,
  runId: string,
  reason: string,
): Promise<void> {
  await destroyWorktree(repo.localPath, worktreePath).catch(() => undefined);
  appendAudit({
    runId: 'system',
    kind: 'worktree_reaped',
    payload: {
      repo: repo.githubFullName,
      runId,
      worktreePath,
      reason,
    },
  });
}

interface WorktreeEntry {
  path: string;
  branch: string;
}

/**
 * Parse `git worktree list --porcelain` output.
 * Each block is:
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 * Blocks are separated by blank lines.
 */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      if (current.path && current.branch) {
        out.push({ path: current.path, branch: current.branch });
      }
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (current.path && current.branch) {
    out.push({ path: current.path, branch: current.branch });
  }
  return out;
}

function parseRunIdFromBranch(branch: string): string | null {
  if (!branch.startsWith('obelisk/')) return null;
  const id = branch.slice('obelisk/'.length);
  return id.length > 0 ? id : null;
}
