import {
  listRuns,
  listLiveRuns,
  getRun,
  deleteRun,
  deleteRunsForRepo,
  archiveRun,
  archiveRunsForRepo,
  restoreRun,
  listArchivedRuns,
  countArchivedRuns,
  deleteArchivedRunsForRepo,
} from '../db/runs';
import { listArtifacts } from '../db/evidence';
import { ObeliskError } from '../../shared/errors';
import { getDb } from '../db';
import type { IpcMap, AuditLine } from '../../shared/types';

export async function handleRunsList(
  payload: IpcMap['runs:list']['req'],
): Promise<IpcMap['runs:list']['res']> {
  return listRuns(payload.repoId, payload.limit ?? 50);
}

export async function handleRunsActiveForRepo(
  payload: IpcMap['runs:activeForRepo']['req'],
): Promise<IpcMap['runs:activeForRepo']['res']> {
  return listLiveRuns(payload.repoId).map((r) => ({
    runId: r.id,
    agentName: r.agentName,
    taskRef: r.taskRef,
    state: r.state,
  }));
}

export async function handleRunsGet(
  payload: IpcMap['runs:get']['req'],
): Promise<IpcMap['runs:get']['res']> {
  const run = getRun(payload.runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${payload.runId} not found`);
  const auditRows = getDb()
    .prepare<
      [string],
      { id: number; run_id: string; at: string; kind: string; payload: string }
    >('SELECT * FROM audit_log WHERE run_id = ? ORDER BY id ASC')
    .all(payload.runId);
  const auditLog: AuditLine[] = auditRows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    at: r.at,
    kind: r.kind,
    payload: safeParse(r.payload),
  }));
  const evidence = listArtifacts(payload.runId).map((a) => ({
    kind: a.kind,
    path: a.path,
    bytes: a.bytes,
    sha256: a.sha256,
  }));
  return { ...run, auditLog, evidence };
}

export async function handleRunsDelete(
  payload: IpcMap['runs:delete']['req'],
): Promise<IpcMap['runs:delete']['res']> {
  deleteRun(payload.runId);
  return { ok: true };
}

export async function handleRunsDeleteCompleted(
  payload: IpcMap['runs:deleteCompleted']['req'],
): Promise<IpcMap['runs:deleteCompleted']['res']> {
  const states = payload.states ?? ['done', 'failed'];
  const deleted = deleteRunsForRepo(payload.repoId, states);
  return { deleted };
}

export async function handleRunsArchive(
  payload: IpcMap['runs:archive']['req'],
): Promise<IpcMap['runs:archive']['res']> {
  archiveRun(payload.runId);
  return { ok: true };
}

export async function handleRunsArchiveCompleted(
  payload: IpcMap['runs:archiveCompleted']['req'],
): Promise<IpcMap['runs:archiveCompleted']['res']> {
  const states = payload.states ?? ['done', 'failed'];
  const archived = archiveRunsForRepo(payload.repoId, states);
  return { archived, total: countArchivedRuns(payload.repoId) };
}

export async function handleArchiveList(
  payload: IpcMap['archive:list']['req'],
): Promise<IpcMap['archive:list']['res']> {
  return listArchivedRuns(payload.repoId, payload.query ?? '', payload.limit ?? 200);
}

export async function handleArchiveCount(
  payload: IpcMap['archive:count']['req'],
): Promise<IpcMap['archive:count']['res']> {
  return { count: countArchivedRuns(payload.repoId) };
}

export async function handleArchiveRestore(
  payload: IpcMap['archive:restore']['req'],
): Promise<IpcMap['archive:restore']['res']> {
  restoreRun(payload.runId);
  return { ok: true };
}

export async function handleArchiveDeleteAll(
  payload: IpcMap['archive:deleteAll']['req'],
): Promise<IpcMap['archive:deleteAll']['res']> {
  return { deleted: deleteArchivedRunsForRepo(payload.repoId) };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * 7-day aggregate stats scoped to one agent instance. Used by the detail-pane
 * Stats card.
 */
export async function handleRunsStats(
  payload: IpcMap['runs:stats']['req'],
): Promise<IpcMap['runs:stats']['res']> {
  const days = payload.days ?? 7;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const db = getDb();

  const totals = db
    .prepare<
      [string, string],
      {
        runs: number;
        avg_duration_ms: number | null;
        failures: number;
      }
    >(
      `SELECT
         COUNT(*)                                                       AS runs,
         AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                  THEN (julianday(finished_at) - julianday(started_at)) * 86400 * 1000
             END)                                                       AS avg_duration_ms,
         SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)              AS failures
       FROM runs
       WHERE agent_id = ? AND COALESCE(started_at, finished_at) >= ?`,
    )
    .get(payload.agentId, since);

  const totalRuns = totals?.runs ?? 0;
  const failures = totals?.failures ?? 0;

  // PRs / issues opened by counting publish-success audit lines, scoped to runs of this agent.
  const opened = db
    .prepare<[string, string], { prs: number; issues: number; reviews: number }>(
      `SELECT
         SUM(CASE WHEN json_extract(al.payload,'$.kind') = 'pr'      THEN 1 ELSE 0 END) AS prs,
         SUM(CASE WHEN json_extract(al.payload,'$.kind') = 'issue'   THEN 1 ELSE 0 END) AS issues,
         SUM(CASE WHEN json_extract(al.payload,'$.kind') = 'review'  THEN 1 ELSE 0 END) AS reviews
       FROM audit_log al
       JOIN runs r ON r.id = al.run_id
       WHERE al.kind = 'published'
         AND r.agent_id = ?
         AND al.at >= ?`,
    )
    .get(payload.agentId, since);

  return {
    runs: totalRuns,
    prsOpened: opened?.prs ?? 0,
    issuesFiled: opened?.issues ?? 0,
    reviewsLeft: opened?.reviews ?? 0,
    falsePositiveRate: totalRuns === 0 ? 0 : failures / totalRuns,
    avgDurationMs: Math.round(totals?.avg_duration_ms ?? 0),
  };
}

/**
 * 168-hour grid (day-of-week × hour) of run counts for one agent.
 */
export async function handleRunsHistogram(
  payload: IpcMap['runs:histogram']['req'],
): Promise<IpcMap['runs:histogram']['res']> {
  const hours = payload.hours ?? 168;
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  const rows = getDb()
    .prepare<[string, string], { started_at: string; state: string }>(
      `SELECT started_at, state FROM runs
       WHERE agent_id = ? AND started_at IS NOT NULL AND started_at >= ?`,
    )
    .all(payload.agentId, since);

  // Map to (dow, hour) buckets. JS getDay: Sun=0..Sat=6; we use Mon=0..Sun=6
  // to match the renderer's grid headers.
  const cells = new Map<
    string,
    { dayOfWeek: number; hour: number; runs: number; issues: number }
  >();
  for (const r of rows) {
    const d = new Date(r.started_at);
    if (Number.isNaN(d.getTime())) continue;
    const dow = (d.getDay() + 6) % 7; // shift so Mon=0
    const hour = d.getHours();
    const key = `${dow}:${hour}`;
    const cur = cells.get(key) ?? { dayOfWeek: dow, hour, runs: 0, issues: 0 };
    cur.runs += 1;
    cells.set(key, cur);
  }
  return { cells: Array.from(cells.values()) };
}
