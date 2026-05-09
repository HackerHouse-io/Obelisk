import { listRepos } from '../db/repos';
import { getLatestRunForTaskRef } from '../db/runs';
import { getGithub } from '../github/client';
import { OBELISK_LABELS } from '../publisher/labels';
import { clearClaimSignals } from '../publisher';
import { appendAudit } from '../logger/audit';
import type { Repo } from '../../shared/types';

/**
 * Stale-after threshold: issues whose owning run finished more than 24h
 * ago AND still carry `obelisk:in-progress`. Mirrors the worktree reaper
 * window so a single 24h knob governs all post-failure cleanup.
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Defense against process-crash orphan signals: if Obelisk dies between
 * `postClaimSignal` and the orchestrator's `clearClaimSignals` finally,
 * the issue keeps the `obelisk:in-progress` label + assignee forever.
 * `runAgent`'s finally hook handles the *graceful* failure path; this
 * sweep handles the hard-crash path.
 *
 * Logic per repo:
 *   1. Find every open issue carrying `obelisk:in-progress`.
 *   2. For each, look up the most recent run with task_ref = `issue#<N>`.
 *   3. Clear claim signals if:
 *        - no run exists (process died before createRun), OR
 *        - run is in a terminal state AND finished > STALE_AFTER_MS ago.
 *   4. Leave the label alone if the run is still in flight.
 */
export async function claimSignalReaperSweep(): Promise<void> {
  for (const repo of listRepos()) {
    await reapRepo(repo).catch((e: unknown) => {
      console.warn(`[obelisk] claim-signal reaper failed for ${repo.githubFullName}:`, e);
    });
  }
}

async function reapRepo(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  let issues;
  try {
    issues = await gh.issues.listForRepo({
      owner,
      repo: name,
      state: 'open',
      labels: OBELISK_LABELS.inProgress,
      per_page: 50,
    });
  } catch (e) {
    appendAudit({
      runId: 'system',
      kind: 'claim_reaper_failed',
      payload: {
        repo: repo.githubFullName,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }

  const now = Date.now();
  for (const issue of issues.data) {
    if (issue.pull_request) continue; // PRs are handled by their own lifecycle
    const taskRef = `issue#${issue.number}`;
    const run = getLatestRunForTaskRef(repo.id, taskRef);

    let shouldReap = false;
    let reason = '';
    if (!run) {
      // No run row at all — process died before createRun completed.
      shouldReap = true;
      reason = 'no_owning_run';
    } else if (run.state === 'done' || run.state === 'failed' || run.state === 'cancelled') {
      const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : NaN;
      if (Number.isFinite(finishedAt) && now - finishedAt > STALE_AFTER_MS) {
        shouldReap = true;
        reason = `terminal_${run.state}_aged_out`;
      }
    }

    if (!shouldReap) continue;

    await clearClaimSignals(repo, issue.number).catch(() => undefined);
    appendAudit({
      runId: 'system',
      kind: 'claim_signal_reaped',
      payload: {
        repo: repo.githubFullName,
        issueNumber: issue.number,
        reason,
        ...(run ? { runId: run.id, runState: run.state } : {}),
      },
    });
  }
}
