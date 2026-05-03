import { listRepos } from '../db/repos';
import { getGithub } from '../github/client';
import { OBELISK_LABELS } from '../publisher/labels';
import { appendAudit } from '../logger/audit';
import type { Repo } from '../../shared/types';

/**
 * Auto-merge sweep (PRD §3.2 / §6.1).
 *
 * Three conditions ALL must hold for a merge:
 *   1. repo.mode === 'automerge'
 *   2. PR carries the `obelisk:automerge` label
 *   3. Combined commit status (legacy + check-runs) is `success`
 *
 * If any condition fails, we audit-log the decision and move on. We never
 * remove the label automatically — leaving the choice with the human.
 *
 * Per-PR outcomes are written to `audit_log` (`auto_merge_skipped` or
 * `auto_merge_merged`); that's the durable signal. The function returns
 * void.
 */
export async function autoMergeSweep(): Promise<void> {
  for (const repo of listRepos()) {
    if (repo.mode !== 'automerge') continue;
    await sweepRepo(repo).catch((e: unknown) => {
      // Network or auth errors are non-fatal — try again next tick.
      console.warn(`[obelisk] auto-merge sweep failed for ${repo.githubFullName}:`, e);
    });
  }
}

async function sweepRepo(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  const { data: prs } = await gh.pulls.list({
    owner,
    repo: name,
    state: 'open',
    per_page: 50,
  });

  for (const pr of prs) {
    if (!pr.labels.some((l) => l.name === OBELISK_LABELS.automerge)) continue;
    if (pr.draft) {
      logSkip(pr.number, 'pr_is_draft');
      continue;
    }

    const checks = await isRefGreen(gh, owner, name, pr.head.sha);
    if (!checks.green) {
      logSkip(pr.number, checks.reason);
      continue;
    }

    try {
      await gh.pulls.merge({
        owner,
        repo: name,
        pull_number: pr.number,
        // Squash is the v0.1 default. v0.2 makes this per-repo configurable.
        merge_method: 'squash',
      });
      logMerge(pr.number);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      logSkip(pr.number, `merge_failed_${status ?? 'unknown'}`);
    }
  }
}

interface GreenCheck {
  green: boolean;
  reason: string;
}

/**
 * Combine legacy commit-statuses (Travis-era) with check-runs (Actions /
 * modern CI). All must be `success` for the ref to count as green.
 */
async function isRefGreen(
  gh: NonNullable<Awaited<ReturnType<typeof getGithub>>>,
  owner: string,
  repo: string,
  ref: string,
): Promise<GreenCheck> {
  const [combined, checks] = await Promise.all([
    gh.repos.getCombinedStatusForRef({ owner, repo, ref }),
    gh.checks.listForRef({ owner, repo, ref, per_page: 100 }),
  ]);

  // Only fail on the legacy combined-status when the repo actually publishes
  // statuses through that API. Pure check-runs repos report `state='pending'`
  // with `statuses=[]` even when their checks are green — fall through to the
  // check-runs loop in that case.
  if (combined.data.statuses.length > 0 && combined.data.state !== 'success') {
    return { green: false, reason: `combined_status_${combined.data.state}` };
  }
  for (const run of checks.data.check_runs) {
    if (run.status !== 'completed') {
      return { green: false, reason: `check_pending_${run.name}` };
    }
    if (
      run.conclusion !== 'success' &&
      run.conclusion !== 'neutral' &&
      run.conclusion !== 'skipped'
    ) {
      return { green: false, reason: `check_failed_${run.name}_${run.conclusion ?? 'null'}` };
    }
  }
  return { green: true, reason: 'all_green' };
}

function logSkip(prNumber: number, reason: string): void {
  // Auto-merge isn't tied to a specific agent run, so the audit row uses
  // the synthetic 'system' run-id.
  appendAudit({
    runId: 'system',
    kind: 'auto_merge_skipped',
    payload: { pr: prNumber, reason },
  });
}

function logMerge(prNumber: number): void {
  appendAudit({
    runId: 'system',
    kind: 'auto_merge_merged',
    payload: { pr: prNumber },
  });
}
