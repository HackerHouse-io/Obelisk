import { ulid } from 'ulid';
import { getDb } from './index';
import { broadcast } from '../ipc/bus';
import type { AgentName, Run, RunState, RunnerKind } from '../../shared/types';

interface RunRow {
  id: string;
  repo_id: string;
  agent_name: AgentName;
  state: RunState;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat_at: string | null;
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  task_ref: string | null;
  runner_used: RunnerKind;
  fallback_used: number;
  output_summary: string | null;
  error_code: string | null;
  worktree_path: string | null;
}

function mapRow(r: RunRow): Run {
  return {
    id: r.id,
    repoId: r.repo_id,
    agentName: r.agent_name,
    state: r.state,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    taskRef: r.task_ref,
    runnerUsed: r.runner_used,
    fallbackUsed: r.fallback_used === 1,
    outputSummary: r.output_summary,
    errorCode: r.error_code,
  };
}

export interface CreateRunInput {
  repoId: string;
  agentName: AgentName;
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  taskRef: string | null;
  runnerUsed: RunnerKind;
}

export function createRun(input: CreateRunInput): Run {
  const id = ulid();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO runs
        (id, repo_id, agent_name, state, started_at, last_heartbeat_at,
         trigger, task_ref, runner_used, fallback_used, output_summary,
         error_code, worktree_path)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
    )
    .run(
      id,
      input.repoId,
      input.agentName,
      now,
      now,
      input.trigger,
      input.taskRef,
      input.runnerUsed,
    );
  const run = getRun(id);
  if (!run) throw new Error('createRun: row vanished');
  broadcast({ type: 'run.created', run });
  return run;
}

export function getRun(id: string): Run | null {
  const row = getDb().prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function listRuns(repoId: string, limit = 50): Run[] {
  return getDb()
    .prepare<
      [string, number],
      RunRow
    >('SELECT * FROM runs WHERE repo_id = ? ORDER BY started_at DESC NULLS LAST LIMIT ?')
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
  const finishedAt = state === 'done' || state === 'failed' ? at : null;

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

export function getWorktreePath(id: string): string | null {
  const row = getDb()
    .prepare<
      [string],
      { worktree_path: string | null }
    >('SELECT worktree_path FROM runs WHERE id = ?')
    .get(id);
  return row?.worktree_path ?? null;
}
