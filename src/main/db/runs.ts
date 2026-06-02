import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import { getDb } from './index';
import { broadcast } from '../ipc/bus';
import { releaseClaimsForRun } from './pr-review-claims';
import { appendAudit } from '../logger/audit';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Run, RunState, RunnerKind } from '../../shared/types';

interface RunRow {
  id: string;
  repo_id: string;
  agent_name: AgentName;
  agent_id: string | null;
  state: RunState;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat_at: string | null;
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  task_ref: string | null;
  task_context: string | null;
  runner_used: RunnerKind;
  fallback_used: number;
  output_summary: string | null;
  error_code: string | null;
  worktree_path: string | null;
  archived_at: string | null;
}

function mapRow(r: RunRow): Run {
  return {
    id: r.id,
    repoId: r.repo_id,
    agentName: r.agent_name,
    agentId: r.agent_id,
    state: r.state,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    taskRef: r.task_ref,
    taskContext: r.task_context,
    runnerUsed: r.runner_used,
    fallbackUsed: r.fallback_used === 1,
    outputSummary: r.output_summary,
    errorCode: r.error_code,
    archivedAt: r.archived_at,
  };
}

export interface CreateRunInput {
  repoId: string;
  agentName: AgentName;
  agentId: string | null;
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  taskRef: string | null;
  /**
   * Snapshot of the task's human-readable context at claim time (typically
   * the GitHub issue title, or the manual backlog item title). Persisted on
   * the run row so the renderer can show "Bug Fixer is working on issue#42
   * — Crash on cold start" without joining back to a row that may have
   * been unlocked/deleted in the meantime.
   */
  taskContext?: string | null;
  runnerUsed: RunnerKind;
}

/**
 * Per-task-ref single-flight: at most one run with the given (repoId, taskRef)
 * can be in a non-terminal state at a time. This is the dedup boundary that
 * lets multiple instances of the same agent type coexist (each can run a
 * different test plan / backlog item / flow), while still preventing two
 * agents from racing on the same task.
 *
 * The check + insert run inside one transaction so two simultaneous calls
 * can't both pass the SELECT and then both INSERT. Throws RUN_ACTIVE when
 * a live run already owns this task ref.
 */
export function createRun(input: CreateRunInput): Run {
  const id = ulid();
  const now = new Date().toISOString();
  const db = getDb();

  const insert = db.transaction(() => {
    if (input.taskRef !== null) {
      const existing = db
        .prepare<[string, string], { id: string; agent_name: AgentName }>(
          `SELECT id, agent_name FROM runs
            WHERE repo_id = ? AND task_ref = ?
              AND state IN ('queued','running','publishing','paused')
            LIMIT 1`,
        )
        .get(input.repoId, input.taskRef);
      if (existing) {
        throw new ObeliskError(
          'RUN_ACTIVE',
          `Another run is already working on "${input.taskRef}".`,
          'Wait for the current run to finish, or cancel it from Mission Control before starting another.',
        );
      }
    }
    db.prepare(
      `INSERT INTO runs
        (id, repo_id, agent_name, agent_id, state, started_at, last_heartbeat_at,
         trigger, task_ref, task_context, runner_used, fallback_used, output_summary,
         error_code, worktree_path)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
    ).run(
      id,
      input.repoId,
      input.agentName,
      input.agentId,
      now,
      now,
      input.trigger,
      input.taskRef,
      input.taskContext ?? null,
      input.runnerUsed,
    );
  });
  insert();

  const run = getRun(id);
  if (!run) throw new Error('createRun: row vanished');
  broadcast({ type: 'run.created', run });
  return run;
}

/**
 * Returns the live run currently holding `taskRef` for this repo, or null.
 * Useful for the renderer when surfacing "this plan is already running" in
 * UI without trying to start a duplicate run.
 */
/**
 * Latest run (any state) for `(repoId, taskRef)`. Used by the claim-signal
 * reaper to decide whether a lingering `obelisk:in-progress` label is
 * orphaned: if the latest run for the same task_ref is terminal and old
 * enough, we clear the label.
 */
export function getLatestRunForTaskRef(repoId: string, taskRef: string): Run | null {
  const row = getDb()
    .prepare<[string, string], RunRow>(
      `SELECT * FROM runs
        WHERE repo_id = ? AND task_ref = ?
        ORDER BY started_at DESC NULLS LAST, id DESC
        LIMIT 1`,
    )
    .get(repoId, taskRef);
  return row ? mapRow(row) : null;
}

export function getActiveRunForTaskRef(repoId: string, taskRef: string): Run | null {
  const row = getDb()
    .prepare<[string, string], RunRow>(
      `SELECT * FROM runs
        WHERE repo_id = ? AND task_ref = ?
          AND state IN ('queued','running','publishing','paused')
        ORDER BY started_at DESC NULLS LAST
        LIMIT 1`,
    )
    .get(repoId, taskRef);
  return row ? mapRow(row) : null;
}

export function getRun(id: string): Run | null {
  const row = getDb().prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/** Mission Control list — hides archived rows. Scheduler/stats/dedup queries
 * read the table directly and still see archived rows on purpose. */
export function listRuns(repoId: string, limit = 50): Run[] {
  return getDb()
    .prepare<
      [string, number],
      RunRow
    >('SELECT * FROM runs WHERE repo_id = ? AND archived_at IS NULL ORDER BY started_at DESC NULLS LAST LIMIT ?')
    .all(repoId, limit)
    .map(mapRow);
}

export function listLiveRuns(repoId: string): Run[] {
  return getDb()
    .prepare<[string], RunRow>(
      `SELECT * FROM runs
       WHERE repo_id = ? AND state IN ('queued','running','publishing','paused')
       ORDER BY started_at ASC NULLS LAST`,
    )
    .all(repoId)
    .map(mapRow);
}

/**
 * Last `started_at` timestamp for any run of `agentName` against `repoId`,
 * regardless of state. Used by the scheduler as the basis for cron's
 * "next fire after this point" computation.
 */
export function getLastRunStartedAt(repoId: string, agentName: AgentName): Date | null {
  const row = getDb()
    .prepare<[string, string], { started_at: string | null }>(
      `SELECT started_at FROM runs
       WHERE repo_id = ? AND agent_name = ?
       ORDER BY started_at DESC NULLS LAST LIMIT 1`,
    )
    .get(repoId, agentName);
  if (!row?.started_at) return null;
  const d = new Date(row.started_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Most recent N finished scheduled runs for this agent instance, newest
 * first. Powers the scheduler's circuit breaker — if the last several
 * scheduled runs all failed within a short window, the scheduler auto-pauses
 * the agent so it doesn't burn credits on a busted setup.
 */
export interface RecentRunSummary {
  state: RunState;
  finishedAt: string | null;
  errorCode: string | null;
  outputSummary: string | null;
}
export function getRecentScheduledRunsForAgent(agentId: string, limit: number): RecentRunSummary[] {
  return getDb()
    .prepare<
      [string, number],
      {
        state: RunState;
        finished_at: string | null;
        error_code: string | null;
        output_summary: string | null;
      }
    >(
      `SELECT state, finished_at, error_code, output_summary
         FROM runs
        WHERE agent_id = ? AND trigger = 'schedule'
          AND state IN ('done','failed','cancelled')
        ORDER BY finished_at DESC NULLS LAST
        LIMIT ?`,
    )
    .all(agentId, limit)
    .map((r) => ({
      state: r.state,
      finishedAt: r.finished_at,
      errorCode: r.error_code,
      outputSummary: r.output_summary,
    }));
}

/** Per-instance variant — the scheduler needs this once instances diverge. */
export function getLastRunStartedAtForAgent(agentId: string): Date | null {
  const row = getDb()
    .prepare<[string], { started_at: string | null }>(
      `SELECT started_at FROM runs
       WHERE agent_id = ?
       ORDER BY started_at DESC NULLS LAST LIMIT 1`,
    )
    .get(agentId);
  if (!row?.started_at) return null;
  const d = new Date(row.started_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function transitionRun(
  id: string,
  state: RunState,
  patch: {
    outputSummary?: string | null;
    errorCode?: string | null;
    worktreePath?: string | null;
    runnerUsed?: RunnerKind;
    fallbackUsed?: boolean;
  } = {},
): Run {
  const at = new Date().toISOString();
  const finishedAt = state === 'done' || state === 'failed' || state === 'cancelled' ? at : null;

  const fields: string[] = ['state = ?', 'last_heartbeat_at = ?'];
  const values: (string | number | null)[] = [state, at];

  if (finishedAt !== null) {
    fields.push('finished_at = ?');
    values.push(finishedAt);
  }
  if (patch.outputSummary !== undefined) {
    fields.push('output_summary = ?');
    values.push(patch.outputSummary);
  }
  if (patch.errorCode !== undefined) {
    fields.push('error_code = ?');
    values.push(patch.errorCode);
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?');
    values.push(patch.worktreePath);
  }
  if (patch.runnerUsed !== undefined) {
    fields.push('runner_used = ?');
    values.push(patch.runnerUsed);
  }
  if (patch.fallbackUsed !== undefined) {
    fields.push('fallback_used = ?');
    values.push(patch.fallbackUsed ? 1 : 0);
  }

  values.push(id);

  getDb()
    .prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);

  const run = getRun(id);
  if (!run) throw new Error(`transitionRun: ${id} not found`);
  broadcast({ type: 'run.transition', runId: id, state, at });
  return run;
}

export function heartbeat(id: string): void {
  getDb()
    .prepare('UPDATE runs SET last_heartbeat_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

/**
 * Startup recovery for general agent runs. An orchestrator run lives entirely
 * in this process (the active-runs map + the spawned CLI); when Obelisk quits
 * or crashes mid-run, the child process dies but the DB row stays in a
 * non-terminal *active* state — so it reads as "live" forever and the
 * per-task-ref single-flight guard blocks any retry.
 *
 * At startup, by definition, no run from a previous process is still alive, so
 * every `queued`/`running`/`publishing` row is orphaned. Fail them as
 * INTERRUPTED (the same terminal shape as a normal failure) and release the
 * locks they were holding — PR-review claims and backlog `in_progress_run` —
 * so the underlying task is free to be picked up again.
 *
 * `paused` is intentionally NOT reconciled: a pause means the run is parked
 * awaiting user input (EVIDENCE_INCOMPLETE / REPRO_FAILED / login), which is a
 * legitimate state to persist across restarts. Mirrors `reconcileCoverageRuns`.
 */
export function reconcileOrphanedRuns(): number {
  const orphaned = getDb()
    .prepare<
      [],
      { id: string; state: RunState }
    >(`SELECT id, state FROM runs WHERE state IN ('queued','running','publishing')`)
    .all();

  for (const row of orphaned) {
    appendAudit({
      runId: row.id,
      kind: 'state',
      payload: { from: row.state, to: 'failed', reason: 'app_restart' },
    });
    transitionRun(row.id, 'failed', {
      errorCode: 'INTERRUPTED',
      outputSummary: 'Interrupted by an app restart.',
    });
    // Free the locks this run held so the task isn't stuck "in progress".
    releaseClaimsForRun(row.id);
    getDb()
      .prepare(
        'UPDATE backlog SET in_progress_run = NULL, last_seen_at = ? WHERE in_progress_run = ?',
      )
      .run(new Date().toISOString(), row.id);
  }
  return orphaned.length;
}

const ACTIVE_STATES: RunState[] = ['queued', 'running', 'publishing'];
const DELETABLE_STATES: RunState[] = ['done', 'failed', 'paused', 'cancelled'];

function filterDeletable(states: RunState[]): RunState[] {
  return states.filter((s) => DELETABLE_STATES.includes(s));
}

/**
 * Delete a single run and all its dependent rows. Refuses to delete a run
 * that's still active so an in-flight orchestrator step can't have its rows
 * yanked out from under it. Best-effort cleanup of the on-disk artifact dir
 * — DB rows go even if the disk cleanup fails.
 */
export function deleteRun(runId: string): void {
  const run = getRun(runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${runId} not found`);
  if (ACTIVE_STATES.includes(run.state)) {
    throw new ObeliskError(
      'RUN_ACTIVE',
      `run ${runId} is still ${run.state}; cancel it before deleting.`,
    );
  }

  const db = getDb();
  // Snapshot artifact paths before the cascade wipes them. We delete the
  // run-level directory, not each file individually, so we don't get
  // confused by symlinks or shared paths.
  const artifactPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM evidence_artifacts WHERE run_id = ?')
    .all(runId)
    .map((r) => r.path);

  const tx = db.transaction((id: string) => {
    // backlog.in_progress_run and non_bugs_learned.source_run reference runs
    // WITHOUT ON DELETE CASCADE — null them out so the DELETE doesn't trip
    // the FK constraint.
    db.prepare('UPDATE backlog SET in_progress_run = NULL WHERE in_progress_run = ?').run(id);
    db.prepare('UPDATE non_bugs_learned SET source_run = NULL WHERE source_run = ?').run(id);
    // audit_log + evidence_artifacts cascade.
    db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  });
  tx(runId);

  // Best-effort disk cleanup. Records live at
  //   <recordsRoot>/<repoId>/<runId>/<kind>/<file>
  // Remove the per-run dir; if multiple artifacts share a parent dir we
  // collapse to that parent (which is the run dir).
  const runDirs = new Set<string>();
  for (const p of artifactPaths) {
    // Walk up two levels: <repoId>/<runId>/<kind>/<file> → <repoId>/<runId>
    const kindDir = dirname(p);
    const runDir = dirname(kindDir);
    runDirs.add(runDir);
  }
  for (const dir of runDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  broadcast({ type: 'run.deleted', runId, repoId: run.repoId });
}

/**
 * Bulk delete every run for a repo whose state is in `states`. Active runs
 * are always skipped, even if a caller asks for them. Returns the number of
 * rows actually deleted.
 */
export function deleteRunsForRepo(repoId: string, states: RunState[]): number {
  const safe = filterDeletable(states);
  if (safe.length === 0) return 0;
  const placeholders = safe.map(() => '?').join(',');
  const rows = getDb()
    .prepare<[string, ...string[]], { id: string }>(
      `SELECT id FROM runs WHERE repo_id = ? AND state IN (${placeholders})`,
    )
    .all(repoId, ...safe);
  let deleted = 0;
  for (const r of rows) {
    try {
      deleteRun(r.id);
      deleted += 1;
    } catch {
      /* skip rows that race into an active state */
    }
  }
  return deleted;
}

/** Soft-delete one run. Active runs are refused — an in-flight orchestrator
 * step would lose its row otherwise. Idempotent. */
export function archiveRun(runId: string): void {
  const run = getRun(runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${runId} not found`);
  if (ACTIVE_STATES.includes(run.state)) {
    throw new ObeliskError(
      'RUN_ACTIVE',
      `run ${runId} is still ${run.state}; cancel it before archiving.`,
    );
  }
  if (run.archivedAt) return; // already archived; idempotent

  getDb()
    .prepare('UPDATE runs SET archived_at = ? WHERE id = ?')
    .run(new Date().toISOString(), runId);

  broadcast({ type: 'run.archived', runId, repoId: run.repoId });
}

/** Bulk soft-delete. Active states are filtered out; emits one
 * archive.bulkChanged event instead of N run.archived events. */
export function archiveRunsForRepo(repoId: string, states: RunState[]): number {
  const safe = filterDeletable(states);
  if (safe.length === 0) return 0;
  const db = getDb();
  const placeholders = safe.map(() => '?').join(',');
  const now = new Date().toISOString();
  const rows = db
    .prepare<[string, ...string[]], { id: string }>(
      `SELECT id FROM runs
        WHERE repo_id = ?
          AND archived_at IS NULL
          AND state IN (${placeholders})`,
    )
    .all(repoId, ...safe);
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE runs SET archived_at = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) update.run(now, r.id);
  });
  tx();
  broadcast({
    type: 'archive.bulkChanged',
    repoId,
    runIds: rows.map((r) => r.id),
  });
  return rows.length;
}

/** Restore an archived run by clearing archived_at. Idempotent. */
export function restoreRun(runId: string): void {
  const run = getRun(runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${runId} not found`);
  if (!run.archivedAt) return;
  getDb().prepare('UPDATE runs SET archived_at = NULL WHERE id = ?').run(runId);
  const restored = getRun(runId);
  if (!restored) return;
  broadcast({ type: 'run.restored', runId, repoId: run.repoId, run: restored });
}

/** Count archived runs for a repo — used by the Mission Control toolbar pill. */
export function countArchivedRuns(repoId: string): number {
  const row = getDb()
    .prepare<
      [string],
      { n: number }
    >('SELECT COUNT(*) AS n FROM runs WHERE repo_id = ? AND archived_at IS NOT NULL')
    .get(repoId);
  return row?.n ?? 0;
}

/**
 * Hard-delete every archived run for a repo. Each row goes through deleteRun
 * so the existing audit/evidence cascade + on-disk cleanup still run.
 * Returns the number of rows actually removed.
 */
export function deleteArchivedRunsForRepo(repoId: string): number {
  const rows = getDb()
    .prepare<
      [string],
      { id: string }
    >('SELECT id FROM runs WHERE repo_id = ? AND archived_at IS NOT NULL')
    .all(repoId);
  let deleted = 0;
  for (const r of rows) {
    try {
      deleteRun(r.id);
      deleted += 1;
    } catch {
      /* skip rows that race into an active state */
    }
  }
  return deleted;
}

/**
 * List archived runs for a repo, newest-archived first. `query` does a
 * case-insensitive LIKE match across the user-facing fields (task_ref,
 * task_context snapshot, agent_name) so the Archive search box can find an
 * old issue by title, by issue number, or by agent kind.
 */
export function listArchivedRuns(repoId: string, query = '', limit = 200): Run[] {
  const trimmed = query.trim();
  const db = getDb();
  if (trimmed === '') {
    return db
      .prepare<[string, number], RunRow>(
        `SELECT * FROM runs
          WHERE repo_id = ? AND archived_at IS NOT NULL
          ORDER BY archived_at DESC
          LIMIT ?`,
      )
      .all(repoId, limit)
      .map(mapRow);
  }
  const like = `%${trimmed.toLowerCase()}%`;
  return db
    .prepare<[string, string, string, string, number], RunRow>(
      `SELECT * FROM runs
        WHERE repo_id = ? AND archived_at IS NOT NULL
          AND (LOWER(IFNULL(task_ref,''))     LIKE ?
            OR LOWER(IFNULL(task_context,'')) LIKE ?
            OR LOWER(agent_name)              LIKE ?)
        ORDER BY archived_at DESC
        LIMIT ?`,
    )
    .all(repoId, like, like, like, limit)
    .map(mapRow);
}

export function getWorktreePath(id: string): string | null {
  const row = getDb()
    .prepare<
      [string],
      { worktree_path: string | null }
    >('SELECT worktree_path FROM runs WHERE id = ?')
    .get(id);
  return row?.worktree_path ?? null;
}
