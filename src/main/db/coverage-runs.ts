import { ulid } from 'ulid';
import { getDb } from './index';
import { isCoverageRunTerminal } from '../../shared/coverage-formula';
import type {
  CoverageRunStage,
  CoverageRunStep,
  CoverageRunStepKind,
  CoverageRunStepState,
  CoverageRunSummary,
  CoverageRunTrigger,
} from '../../shared/types';

/**
 * Persistence for the Coverage Agent's autonomous passes. One `coverage_runs`
 * row per pass; `coverage_run_steps` is its timeline. The loop itself
 * (coverage/agent-loop.ts) drives the stage machine — this module is plain
 * CRUD that maps rows to the `CoverageRunSummary` the renderer consumes.
 */

interface CoverageRunRow {
  id: string;
  repo_id: string;
  trigger: CoverageRunTrigger;
  stage: CoverageRunStage;
  status: string | null;
  budget_spawns: number;
  spawns_used: number;
  gap_threshold: number;
  cancel_requested: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  error_hint: string | null;
}

interface CoverageStepRow {
  id: number;
  coverage_run_id: string;
  kind: CoverageRunStepKind;
  feature_label: string | null;
  ref: string | null;
  run_id: string | null;
  findings: number | null;
  state: CoverageRunStepState;
  detail: string | null;
  at: string;
}

function mapStep(r: CoverageStepRow): CoverageRunStep {
  return {
    id: r.id,
    kind: r.kind,
    featureLabel: r.feature_label,
    ref: r.ref,
    runId: r.run_id,
    findings: r.findings,
    state: r.state,
    detail: r.detail,
    at: r.at,
  };
}

function loadSteps(coverageRunId: string): CoverageRunStep[] {
  return getDb()
    .prepare<
      [string],
      CoverageStepRow
    >('SELECT * FROM coverage_run_steps WHERE coverage_run_id = ? ORDER BY id ASC')
    .all(coverageRunId)
    .map(mapStep);
}

function mapRun(r: CoverageRunRow): CoverageRunSummary {
  return {
    id: r.id,
    repoId: r.repo_id,
    trigger: r.trigger,
    stage: r.stage,
    status: r.status,
    budgetSpawns: r.budget_spawns,
    spawnsUsed: r.spawns_used,
    gapThreshold: r.gap_threshold,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    errorMessage: r.error_message,
    errorHint: r.error_hint,
    steps: loadSteps(r.id),
  };
}

export interface CreateCoverageRunInput {
  repoId: string;
  trigger: CoverageRunTrigger;
  gapThreshold: number;
  budgetSpawns: number;
}

export function createCoverageRun(input: CreateCoverageRunInput): CoverageRunSummary {
  const id = `cov-${ulid().slice(-12).toLowerCase()}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO coverage_runs
         (id, repo_id, trigger, stage, status, budget_spawns, spawns_used, gap_threshold, cancel_requested, started_at)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, 0, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.trigger,
      'Queued — preparing a coverage pass…',
      input.budgetSpawns,
      input.gapThreshold,
      now,
    );
  return getCoverageRun(id)!;
}

export function getCoverageRun(id: string): CoverageRunSummary | null {
  const row = getDb()
    .prepare<[string], CoverageRunRow>('SELECT * FROM coverage_runs WHERE id = ?')
    .get(id);
  return row ? mapRun(row) : null;
}

/**
 * The pass the renderer should show for a repo: the active (non-terminal) one
 * if present, otherwise the most recently started pass.
 */
export function getLatestCoverageRun(repoId: string): CoverageRunSummary | null {
  const row = getDb()
    .prepare<[string], CoverageRunRow>(
      `SELECT * FROM coverage_runs WHERE repo_id = ?
       ORDER BY (stage IN ('done','failed','cancelled')) ASC, started_at DESC
       LIMIT 1`,
    )
    .get(repoId);
  return row ? mapRun(row) : null;
}

/** The active (non-terminal) pass for a repo, if any — the single-flight gate. */
export function getActiveCoverageRun(repoId: string): CoverageRunSummary | null {
  const row = getDb()
    .prepare<[string], CoverageRunRow>(
      `SELECT * FROM coverage_runs
       WHERE repo_id = ? AND stage NOT IN ('done','failed','cancelled')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(repoId);
  return row ? mapRun(row) : null;
}

export function listCoverageRuns(repoId: string, limit = 20): CoverageRunSummary[] {
  return getDb()
    .prepare<
      [string, number],
      CoverageRunRow
    >('SELECT * FROM coverage_runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(repoId, limit)
    .map(mapRun);
}

export function advanceCoverageStage(
  id: string,
  stage: CoverageRunStage,
  status?: string,
): CoverageRunSummary | null {
  const finishedAt = isCoverageRunTerminal(stage) ? new Date().toISOString() : null;
  getDb()
    .prepare(
      `UPDATE coverage_runs
         SET stage = ?, status = COALESCE(?, status), finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    )
    .run(stage, status ?? null, finishedAt, id);
  return getCoverageRun(id);
}

export function failCoverageRun(
  id: string,
  errorMessage: string,
  errorHint?: string,
  status?: string,
): CoverageRunSummary | null {
  getDb()
    .prepare(
      `UPDATE coverage_runs
         SET stage = 'failed', status = COALESCE(?, 'Coverage pass failed.'),
             error_message = ?, error_hint = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(status ?? null, errorMessage, errorHint ?? null, new Date().toISOString(), id);
  return getCoverageRun(id);
}

/** Bump the spawn counter. Returns the new total so callers can budget-check. */
export function incrementSpawns(id: string, by = 1): number {
  const row = getDb()
    .prepare<
      [number, string],
      { spawns_used: number }
    >('UPDATE coverage_runs SET spawns_used = spawns_used + ? WHERE id = ? RETURNING spawns_used')
    .get(by, id);
  return row?.spawns_used ?? 0;
}

export function requestCancelCoverageRun(id: string): void {
  getDb().prepare('UPDATE coverage_runs SET cancel_requested = 1 WHERE id = ?').run(id);
}

export function isCancelRequested(id: string): boolean {
  const row = getDb()
    .prepare<
      [string],
      { cancel_requested: number }
    >('SELECT cancel_requested FROM coverage_runs WHERE id = ?')
    .get(id);
  return (row?.cancel_requested ?? 0) === 1;
}

export interface AppendStepInput {
  coverageRunId: string;
  kind: CoverageRunStepKind;
  featureLabel?: string | null;
  ref?: string | null;
  state: CoverageRunStepState;
  detail?: string | null;
}

export function appendCoverageStep(input: AppendStepInput): number {
  const res = getDb()
    .prepare(
      `INSERT INTO coverage_run_steps (coverage_run_id, kind, feature_label, ref, state, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.coverageRunId,
      input.kind,
      input.featureLabel ?? null,
      input.ref ?? null,
      input.state,
      input.detail ?? null,
      new Date().toISOString(),
    );
  return Number(res.lastInsertRowid);
}

export function updateCoverageStep(
  stepId: number,
  patch: {
    state?: CoverageRunStepState;
    ref?: string | null;
    detail?: string | null;
    runId?: string | null;
    findings?: number | null;
  },
): void {
  // COALESCE = set-or-keep: passing `undefined` (→ null) leaves the column
  // untouched. `findings` therefore goes NULL → N once, monotonically.
  getDb()
    .prepare(
      `UPDATE coverage_run_steps
         SET state    = COALESCE(?, state),
             ref      = COALESCE(?, ref),
             detail   = COALESCE(?, detail),
             run_id   = COALESCE(?, run_id),
             findings = COALESCE(?, findings)
       WHERE id = ?`,
    )
    .run(
      patch.state ?? null,
      patch.ref ?? null,
      patch.detail ?? null,
      patch.runId ?? null,
      patch.findings ?? null,
      stepId,
    );
}

/**
 * Mark any non-terminal pass as failed on startup. The loop's spawned jobs
 * live in memory, so a pass interrupted by an app restart can never resume —
 * fail it cleanly with an actionable hint. The next pass recomputes gaps from
 * scratch (idempotent), so nothing is lost.
 */
export function reconcileCoverageRuns(): number {
  const res = getDb()
    .prepare(
      `UPDATE coverage_runs
         SET stage = 'failed',
             status = 'Interrupted by an app restart.',
             error_message = 'The coverage pass was interrupted when Obelisk restarted.',
             error_hint = 'Click "Run coverage pass" to start a fresh pass — it picks up from current coverage.',
             finished_at = ?
       WHERE stage NOT IN ('done','failed','cancelled')`,
    )
    .run(new Date().toISOString());
  return res.changes;
}
