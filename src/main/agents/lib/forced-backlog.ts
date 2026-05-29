import {
  getBacklogItem,
  listBacklog,
  lockBacklogItem,
  releaseStaleBacklogLocks,
} from '../../db/backlog';
import type { BacklogItem } from '../../../shared/types';
import type { ParsedBacklogTaskRef } from '../../../shared/task-refs';

/**
 * Re-target a specific backlog item for a forced retry (manual Retry button /
 * infra auto-retry). Bypasses the normal sweep's closed/locked/trigger-gone
 * filters — the user is explicitly re-running a known task — but never steals
 * a row a LIVE run still holds.
 *
 * Returns the row, locked to `placeholder` (the orchestrator promotes that to
 * the real run id post-createRun, exactly like the normal claim path). Returns
 * null when the row is gone, the kind doesn't match, or a live run owns it.
 */
export function forcedBacklogItem(opts: {
  repoId: string;
  kind: 'bug' | 'feature';
  ref: ParsedBacklogTaskRef;
  placeholder: string;
}): BacklogItem | null {
  // Clear orphan locks from the failed run we're retrying so its row is
  // visible again. Any non-pending lock that survives belongs to a live run.
  releaseStaleBacklogLocks(opts.repoId);

  const ref = opts.ref;
  const found =
    ref.kind === 'issue'
      ? (listBacklog(opts.repoId).find(
          (b) => b.kind === opts.kind && b.githubIssue === ref.issueNumber,
        ) ?? null)
      : getBacklogItem(ref.id);

  if (!found || found.kind !== opts.kind) return null;

  // Re-read after the release so the lock state is current.
  const fresh = getBacklogItem(found.id);
  if (!fresh) return null;
  if (fresh.inProgressRun && !fresh.inProgressRun.startsWith('pending:')) {
    // A live run still holds it — don't double-run.
    return null;
  }

  lockBacklogItem(fresh.id, opts.placeholder);
  return fresh;
}
