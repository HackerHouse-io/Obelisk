import { getDb } from '../db';
import { transitionRun } from '../db/runs';
import { appendAudit } from '../logger/audit';

interface StaleRow {
  id: string;
  agent_name: string;
  state: string;
  last_heartbeat_at: string | null;
  timeout_ms: number;
}

const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Reap runs that have been silent for longer than 2× their agent's
 * timeout. LEFT JOIN: the agent row may have been deleted between run
 * creation and reap; COALESCE handles the rare NULL case with a 30-min
 * default.
 *
 * `transitionRun → state='failed'` broadcasts on the bus, so Mission
 * Control updates without an additional refresh.
 */
export function reapStaleRuns(now: Date = new Date()): { reaped: string[] } {
  const rows = getDb()
    .prepare<[number], StaleRow>(
      `SELECT r.id, r.agent_name, r.state, r.last_heartbeat_at,
              COALESCE(a.timeout_ms, ?) AS timeout_ms
       FROM runs r
       LEFT JOIN agents a ON a.repo_id = r.repo_id AND a.name = r.agent_name
       WHERE r.state IN ('queued','running','publishing')`,
    )
    .all(FALLBACK_TIMEOUT_MS);

  const reaped: string[] = [];
  for (const row of rows) {
    if (!row.last_heartbeat_at) continue;
    const heartbeatMs = new Date(row.last_heartbeat_at).getTime();
    if (Number.isNaN(heartbeatMs)) continue;
    const cutoffMs = row.timeout_ms * 2;
    if (now.getTime() - heartbeatMs <= cutoffMs) continue;

    appendAudit({
      runId: row.id,
      kind: 'state',
      payload: {
        from: row.state,
        to: 'failed',
        reason: 'heartbeat_lost',
        lastHeartbeatAt: row.last_heartbeat_at,
        cutoffMs,
      },
    });
    transitionRun(row.id, 'failed', {
      errorCode: 'TIMEOUT',
      outputSummary: `No heartbeat for >${Math.round(cutoffMs / 60000)} min`,
    });
    reaped.push(row.id);
  }
  return { reaped };
}
