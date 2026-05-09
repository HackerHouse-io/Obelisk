import { getDb } from '../db';
import type { IpcMap } from '../../shared/types';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Aggregate the last 7 days of bug-fixer + feature-builder activity into a
 * single panel-shaped payload. Joins `audit_log` (rebases, retries,
 * escalations, cross-install skips) with `runs` (PRs published,
 * runs failed).
 *
 * Cheap (a handful of indexed counts), so the renderer can call it on
 * mount + on each `run.transition` bus event without paging.
 */
export async function handleBugFixerHealth(
  payload: IpcMap['bugFixer:health']['req'],
): Promise<IpcMap['bugFixer:health']['res']> {
  const db = getDb();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const runsByState = (state: string): number =>
    db
      .prepare<[string, string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM runs
          WHERE repo_id = ? AND agent_name = 'bug-fixer'
            AND id != 'system'
            AND state = ? AND COALESCE(finished_at, started_at) >= ?`,
      )
      .get(payload.repoId, state, since)?.c ?? 0;

  const auditCount = (kind: string, payloadFilter?: { key: string; eq: string }): number => {
    if (payloadFilter) {
      return (
        db
          .prepare<[string, string, string], { c: number }>(
            `SELECT COUNT(*) AS c FROM audit_log
              WHERE kind = ? AND at >= ?
                AND json_extract(payload, ?) = 1`,
          )
          .get(kind, since, `$.${payloadFilter.key}`)?.c ?? 0
      );
    }
    return (
      db
        .prepare<[string, string], { c: number }>(
          `SELECT COUNT(*) AS c FROM audit_log
            WHERE kind = ? AND at >= ?`,
        )
        .get(kind, since)?.c ?? 0
    );
  };

  const auditCountByOutcome = (kind: string, outcome: string): number =>
    db
      .prepare<[string, string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM audit_log
          WHERE kind = ? AND at >= ?
            AND json_extract(payload, '$.outcome') = ?`,
      )
      .get(kind, since, outcome)?.c ?? 0;

  // PRs opened: a `published` audit row whose payload kind is 'pr'.
  const prsOpened =
    db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM audit_log a
          JOIN runs r ON r.id = a.run_id
          WHERE a.kind = 'published'
            AND r.agent_name = 'bug-fixer'
            AND a.at >= ?
            AND json_extract(a.payload, '$.kind') = 'pr'`,
      )
      .get(since)?.c ?? 0;

  return {
    windowStart: since,
    prsOpened,
    runsDone: runsByState('done'),
    runsFailed: runsByState('failed'),
    rebaseSuccess: auditCountByOutcome('pr_rebase_attempt', 'success'),
    rebaseConflict: auditCountByOutcome('pr_rebase_attempt', 'conflict'),
    rebaseError: auditCountByOutcome('pr_rebase_attempt', 'error'),
    rebaseEscalated: auditCountByOutcome('pr_rebase_attempt', 'escalated'),
    ciRetrySuccess: auditCountByOutcome('pr_ci_retry', 'success'),
    ciRetryFailed: auditCountByOutcome('pr_ci_retry', 'failed'),
    ciRetryEscalated: auditCountByOutcome('pr_ci_retry', 'escalated'),
    crossInstallSkipped: auditCount('cross_install_skipped'),
    claimSignalReaped: auditCount('claim_signal_reaped'),
  };
}
