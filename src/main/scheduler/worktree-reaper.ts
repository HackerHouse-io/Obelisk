import { simpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { listRepos } from '../db/repos';
import { getRun, listLiveRuns, getWorktreePath } from '../db/runs';
import { destroyWorktree, parseWorktreeList } from '../git/worktree';
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
  // BULLETPROOF GUARD: never reap a worktree that a LIVE run currently owns.
  // This is matched by directory, independent of the git branch — a PR Reviewer
  // fix-mode (or CI-resume) run attaches its worktree to ANOTHER run's branch
  // (the PR's existing `obelisk/<originalRunId>` head), so branch-based owner
  // detection would mis-attribute the live worktree to the long-gone original
  // run and force-remove it mid-execution. (That was the bug.)
  const liveOwnedDirs = new Set(
    listLiveRuns(repo.id)
      .map((r) => getWorktreePath(r.id))
      .filter((p): p is string => !!p)
      .map((p) => basename(p)),
  );
  const now = Date.now();
  for (const wt of worktrees) {
    if (liveOwnedDirs.has(basename(wt.path))) continue;
    // The OWNING run is encoded in the worktree DIRECTORY name (the slot), not
    // the branch. Fall back to the branch only for legacy `obelisk/<runId>`
    // worktrees whose dir doesn't carry a run id.
    const runId = parseOwningRunId(wt.path, wt.branch);
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

/**
 * The run that OWNS a worktree, from its directory name (the slot). Slots are
 * `<runId>`, `<runId>-pr<n>`, or `<originalRunId>-resume-<runId>` — in every
 * case the leading ULID is a run we created the worktree for. Falls back to the
 * `obelisk/<runId>` branch only when the dir carries no ULID.
 */
function parseOwningRunId(worktreePath: string, branch: string): string | null {
  const fromDir = /^([0-9A-HJKMNP-TV-Z]{26})/i.exec(basename(worktreePath))?.[1];
  if (fromDir) return fromDir;
  return parseRunIdFromBranch(branch);
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

function parseRunIdFromBranch(branch: string): string | null {
  if (!branch.startsWith('obelisk/')) return null;
  const id = branch.slice('obelisk/'.length);
  return id.length > 0 ? id : null;
}
