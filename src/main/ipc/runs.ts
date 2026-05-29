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
import { getAgent } from '../db/agents';
import { getRepo } from '../db/repos';
import { getGithub } from '../github/client';
import { dispatchAgentRun } from './agents';
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

export async function handleRunsRetry(
  payload: IpcMap['runs:retry']['req'],
): Promise<IpcMap['runs:retry']['res']> {
  const run = getRun(payload.runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${payload.runId} not found`);
  if (
    run.state !== 'failed' &&
    run.state !== 'cancelled' &&
    run.state !== 'done' &&
    run.state !== 'paused'
  ) {
    throw new ObeliskError(
      'RUN_ACTIVE',
      'This run is still active — stop it before retrying.',
      'Wait for the run to finish (or click Stop), then retry.',
    );
  }
  if (!run.agentId) {
    throw new ObeliskError(
      'AGENT_NOT_FOUND',
      'This run is not linked to an agent instance, so it can’t be retried.',
      'Run the agent again from the Agents screen.',
    );
  }
  if (!run.taskRef) {
    throw new ObeliskError(
      'NOT_FOUND',
      'This run has no task reference to retry.',
      'Run the agent again from the Agents screen.',
    );
  }
  const agent = getAgent(run.agentId);
  if (!agent) throw new ObeliskError('AGENT_NOT_FOUND', `agent ${run.agentId} not found`);

  // When the user supplied clarification (retrying a REPRO_FAILED pause), post
  // it as a comment on the linked GitHub issue first — durable, visible to
  // teammates, and a paper trail for why the agent was re-run. Best-effort: a
  // comment failure must not block the (more important) re-run.
  const clarification = payload.userClarification?.trim();
  if (clarification) {
    await postClarificationComment(run.repoId, run.taskRef, clarification).catch(() => undefined);
  }

  // Force the exact task the failed run targeted, bypassing dedup/caps; the
  // atomic claim still prevents true duplicates.
  return dispatchAgentRun(agent, {
    taskId: run.taskRef,
    forceTask: true,
    retryOfRunId: run.id,
    ...(clarification ? { userClarification: clarification } : {}),
  });
}

/**
 * Post the user's retry clarification as a comment on the linked GitHub issue
 * (`issue#<n>` task refs only). Best-effort and self-contained: resolves
 * silently when there's no GitHub-backed issue, no auth, or a bad repo name.
 */
async function postClarificationComment(
  repoId: string,
  taskRef: string | null,
  clarification: string,
): Promise<void> {
  if (!taskRef?.startsWith('issue#')) return;
  const issueNumber = Number.parseInt(taskRef.slice('issue#'.length), 10);
  if (!Number.isInteger(issueNumber)) return;
  const repo = getRepo(repoId);
  if (!repo) return;
  const [owner, repoName] = repo.githubFullName.split('/');
  if (!owner || !repoName) return;
  const gh = await getGithub();
  if (!gh) return;
  await gh.issues.createComment({
    owner,
    repo: repoName,
    issue_number: issueNumber,
    body: `**Obelisk — clarification provided on retry:**\n\n${clarification}`,
  });
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
