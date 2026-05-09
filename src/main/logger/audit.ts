import { getDb } from '../db';
import { broadcast } from '../ipc/bus';
import type { AuditLine } from '../../shared/types';

export interface AuditAppendInput {
  runId: string;
  kind: string;
  payload: unknown;
}

const SYSTEM_RUN_ID = 'system';
let systemSentinelEnsured = false;

/**
 * `audit_log.run_id` references `runs(id)` with FKs enforced. Sweeps that
 * aren't tied to an agent run (auto-merge, scheduler errors, claim-signal
 * reaper, cross-install guard) write rows under `runId: 'system'`. Without
 * a sentinel row that FK rejects every insert; before this guard those
 * audits silently failed in production because the callers ran inside
 * catch-blocks / `void`-promises that swallowed the exception.
 *
 * Lazily upsert a `runs.id = 'system'` row the first time someone writes
 * a system audit. We attach it to an arbitrary existing repo (any will
 * do — the sentinel never participates in run/repo logic) so the
 * `repo_id NOT NULL` constraint is satisfied. If no repo is connected
 * yet, system audits are dropped (matches the prior behaviour for those
 * pre-connect events; the first repo-connect lands the row and from then
 * on every system audit persists).
 */
function ensureSystemSentinel(db: ReturnType<typeof getDb>): boolean {
  if (systemSentinelEnsured) return true;
  const exists = db
    .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM runs WHERE id = ?')
    .get(SYSTEM_RUN_ID);
  if ((exists?.c ?? 0) > 0) {
    systemSentinelEnsured = true;
    return true;
  }
  const repo = db.prepare<[], { id: string }>('SELECT id FROM repos LIMIT 1').get();
  if (!repo) return false;
  const epoch = '1970-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO runs (
      id, repo_id, agent_name, agent_id, state, started_at, finished_at,
      last_heartbeat_at, trigger, task_ref, task_context, runner_used, fallback_used,
      output_summary, error_code, worktree_path
    ) VALUES (?, ?, 'bug-fixer', NULL, 'done', ?, ?, ?, 'manual', NULL, NULL, 'claude', 0,
              'system audit sentinel', NULL, NULL)`,
  ).run(SYSTEM_RUN_ID, repo.id, epoch, epoch, epoch);
  systemSentinelEnsured = true;
  return true;
}

/** Test hook: forget the cached "sentinel was created" flag between DBs. */
export function _resetSystemSentinelCacheForTesting(): void {
  systemSentinelEnsured = false;
}

/**
 * Append a row to audit_log and broadcast it on the IPC bus so any
 * Mission Control drawer watching this run repaints. `runId='system'`
 * is reserved for app-level events that aren't tied to a specific run
 * (sweeps, scheduler errors, claim-signal reaper, cross-install guard).
 */
export function appendAudit(input: AuditAppendInput): void {
  const db = getDb();
  if (input.runId === SYSTEM_RUN_ID && !ensureSystemSentinel(db)) {
    // No connected repo yet → no FK target to attach the sentinel to.
    // Drop the audit silently so the FK doesn't throw.
    return;
  }

  const at = new Date().toISOString();
  const result = db
    .prepare<
      [string, string, string, string],
      void
    >('INSERT INTO audit_log (run_id, at, kind, payload) VALUES (?, ?, ?, ?)')
    .run(input.runId, at, input.kind, JSON.stringify(input.payload));

  // System-scope events (no run row) are skipped on broadcast — Mission
  // Control filters by runId, so there's no listener for 'system'.
  if (input.runId === SYSTEM_RUN_ID) return;

  const line: AuditLine = {
    id: Number(result.lastInsertRowid),
    runId: input.runId,
    at,
    kind: input.kind,
    payload: input.payload,
  };
  broadcast({ type: 'run.audit', runId: input.runId, line });
}

/**
 * For app-level events that should never appear in a run-scoped audit
 * trail, we still want a paper trail. Phase 2 only uses this for OAuth
 * Device Flow + first-time API calls; Phase 4+ writes against real run
 * IDs.
 */
export function appendSystemAudit(kind: string, payload: unknown): void {
  // No-op for now — Phase 2 doesn't have a system_audit table. We just
  // discard so we don't pollute audit_log with rows that have no run.
  // (Console log so devs can still see them.)
  console.log(`[obelisk system audit] ${kind}`, payload);
}
