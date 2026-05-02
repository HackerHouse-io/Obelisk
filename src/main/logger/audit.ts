import { getDb } from '../db';
import { broadcast } from '../ipc/bus';
import type { AuditLine } from '../../shared/types';

export interface AuditAppendInput {
  runId: string;
  kind: string;
  payload: unknown;
}

/**
 * Append a row to audit_log and broadcast it on the IPC bus so any
 * Mission Control drawer watching this run repaints. `runId='system'`
 * is reserved for app-level events that aren't tied to a specific run
 * (e.g. an api_call made during sign-in).
 */
export function appendAudit(input: AuditAppendInput): void {
  const at = new Date().toISOString();
  const result = getDb()
    .prepare<
      [string, string, string, string],
      void
    >('INSERT INTO audit_log (run_id, at, kind, payload) VALUES (?, ?, ?, ?)')
    .run(input.runId, at, input.kind, JSON.stringify(input.payload));

  // System-scope events (no run row) are skipped on broadcast — Mission
  // Control filters by runId, so there's no listener for 'system'.
  if (input.runId === 'system') return;

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
