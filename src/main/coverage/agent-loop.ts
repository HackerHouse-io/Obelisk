import type {
  CoverageReport,
  CoverageRunStage,
  CoverageRunStepState,
  CoverageRunSummary,
  CoverageRunTrigger,
} from '../../shared/types';
import { pickGaps } from '../../shared/coverage-formula';
import { broadcast } from '../ipc/bus';
import { getRepo } from '../db/repos';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import type { CodingAgentRunner } from '../runners/types';
import { buildCoverageReport } from './aggregate';
import { startMapGenerationJob, type GenerateMapInput } from './generate-map';
import { startGenerationJob, type GenerateInput } from '../test-plans/generate';
import { runAgent, type RunAgentInput, type RunAgentOutput } from '../orchestrator/run';
import { cancelRun } from '../orchestrator/active-runs';
import { countPreviewsForRun } from '../db/previews';
import {
  awaitCoverageMapJob,
  awaitTestPlanJob,
  type AwaitJobOptions,
  type JobOutcome,
} from './loop-await';
import {
  advanceCoverageStage,
  appendCoverageStep,
  createCoverageRun,
  failCoverageRun,
  getActiveCoverageRun,
  getCoverageRun,
  incrementSpawns,
  isCancelRequested,
  reconcileCoverageRuns as reconcileCoverageRunsDb,
  requestCancelCoverageRun,
  updateCoverageStep,
} from '../db/coverage-runs';

/**
 * The Coverage Agent: an autonomous pass that walks the repo and closes
 * coverage gaps with minimal user input. It owns no CLI of its own — it
 * SEQUENCES proven primitives:
 *
 *   1. mapping   — ensure `qa/coverage-map.md` exists (LLM scan if not).
 *   2. detecting — buildCoverageReport + pickGaps to find weak features.
 *   3. drafting  — for each gap WITHOUT a covering plan, auto-generate one
 *                  (intentional + deduped: never regenerate an existing plan).
 *   4. hunting   — run the Bug Hunter over a prioritized queue of plans
 *                  (newly drafted + existing, worst-coverage feature first),
 *                  surfacing findings as previews.
 *
 * Every pass is bounded by a spawn budget so a huge repo can't blow up cost;
 * remaining work rolls to the next pass (manual button or scheduled sweep),
 * which is how coverage converges toward "everything tested" over time.
 *
 * Reliability is built on reuse: each spawned step flows through the existing
 * job engines / orchestrator, inheriting their timeouts, single-flight, and
 * circuit breaker. One bad gap (junk plan, runner hiccup) is recorded and the
 * pass moves on; only a hard blocker (no CLI, auth expired) aborts the pass.
 */

export const DEFAULT_GAP_THRESHOLD = 70;
export const DEFAULT_BUDGET_SPAWNS = 8;

/**
 * On a MANUAL pass, auto-pause for review after this many hunts so the user
 * sees what was found before the agent grinds through the rest of the budget.
 * Scheduled/autonomous passes ignore this and run straight to budget.
 * Set to `Infinity` (via `CoverageLoopOptions.checkpointInterval`) to disable.
 */
export const HUNT_CHECKPOINT_INTERVAL = 3;

export interface CoverageLoopOptions {
  trigger?: CoverageRunTrigger;
  gapThreshold?: number;
  budgetSpawns?: number;
  /** Auto-pause cadence for manual passes (default HUNT_CHECKPOINT_INTERVAL). */
  checkpointInterval?: number;
  /** Injected for tests so hunt dispatch uses a MockRunner instead of a real CLI. */
  runnerFactory?: (kind: 'claude' | 'codex') => CodingAgentRunner;
}

/**
 * Seam for unit tests. Production uses the real implementations; tests swap
 * in stubs so a pass can be driven without spawning real CLIs.
 */
export interface CoverageLoopDeps {
  buildReport: (repoId: string) => Promise<CoverageReport>;
  startMap: (input: GenerateMapInput) => string;
  awaitMap: (jobId: string, opts?: AwaitJobOptions) => Promise<JobOutcome>;
  startGenerate: (input: GenerateInput) => string;
  awaitGenerate: (jobId: string, opts?: AwaitJobOptions) => Promise<JobOutcome>;
  runHunt: (input: RunAgentInput) => Promise<RunAgentOutput>;
  runnerAvailable: () => Promise<boolean>;
}

function defaultDeps(): CoverageLoopDeps {
  return {
    buildReport: buildCoverageReport,
    startMap: startMapGenerationJob,
    awaitMap: awaitCoverageMapJob,
    startGenerate: startGenerationJob,
    awaitGenerate: awaitTestPlanJob,
    runHunt: runAgent,
    runnerAvailable: async () => {
      if ((await new ClaudeCodeRunner().isInstalled()).ok) return true;
      if ((await new CodexRunner().isInstalled()).ok) return true;
      return false;
    },
  };
}

/**
 * In-memory complement to the `coverage_runs` row: the live handles only the
 * running process can use. The DB row is durable truth for the UI and restart
 * reconciliation; this object lets `cancel`/`pause`/`resume` act on in-flight
 * work IMMEDIATELY (abort the live hunt, unblock a bus-await, un-park a paused
 * loop). Single-flight per repo guarantees at most one live pass, but we key by
 * coverageRunId so the handle is unambiguous. Created in `startCoverageRun`,
 * reaped in its `finally`.
 */
interface LoopControl {
  /** Hard cancel requested — abort live work and exit to 'cancelled'. */
  cancelled: boolean;
  /** Pause requested — park at the next checkpoint; never kills in-flight work. */
  pauseRequested: boolean;
  /** runId of the qa-hunter currently in flight (set via onStarted, cleared after). */
  activeHuntRunId: string | null;
  /** Aborts the bus-await for a map/generate job (stops waiting; the job lives on). */
  abort: AbortController;
  /** Resolves to wake a parked (paused) loop. Null when not parked. */
  wake: (() => void) | null;
}

const controls = new Map<string, LoopControl>();

function makeControl(): LoopControl {
  return {
    cancelled: false,
    pauseRequested: false,
    activeHuntRunId: null,
    abort: new AbortController(),
    wake: null,
  };
}

/** Broadcast the current summary so the Coverage Agent card repaints. */
function emit(coverageRunId: string): CoverageRunSummary | null {
  const run = getCoverageRun(coverageRunId);
  if (run) broadcast({ type: 'coverageRun.progress', run });
  return run;
}

/**
 * Start a coverage pass. Returns the coverageRunId immediately; the pass runs
 * in the background and reports progress via `coverageRun.progress`.
 *
 * Single-flight per repo: if a pass is already active, its id is returned and
 * no second pass starts (mirrors the test-plan job tracker).
 */
export function startCoverageRun(
  repoId: string,
  opts: CoverageLoopOptions = {},
  depsOverride?: Partial<CoverageLoopDeps>,
): string {
  const active = getActiveCoverageRun(repoId);
  if (active) return active.id;

  const run = createCoverageRun({
    repoId,
    trigger: opts.trigger ?? 'manual',
    gapThreshold: opts.gapThreshold ?? DEFAULT_GAP_THRESHOLD,
    budgetSpawns: opts.budgetSpawns ?? DEFAULT_BUDGET_SPAWNS,
  });
  emit(run.id);

  const control = makeControl();
  controls.set(run.id, control);

  const deps: CoverageLoopDeps = { ...defaultDeps(), ...depsOverride };
  void runPass(run.id, repoId, opts, deps, control)
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      failCoverageRun(run.id, message);
      emit(run.id);
    })
    .finally(() => controls.delete(run.id));
  return run.id;
}

/**
 * Hard cancel: abort the live qa-hunter NOW (don't wait minutes for it to
 * finish), stop waiting on any map/generate job, and un-park a paused loop.
 * Also persist the DB flag so a cancel landing in the microscopic window
 * before the control is registered still takes effect at the first checkpoint.
 */
export function cancelCoverageRun(coverageRunId: string): void {
  const c = controls.get(coverageRunId);
  if (c) {
    c.cancelled = true;
    c.abort.abort(); // unblock an in-flight awaitMap/awaitGenerate
    if (c.activeHuntRunId) cancelRun(c.activeHuntRunId); // SIGTERM→SIGKILL the live CLI
    c.wake?.(); // wake if parked in pause
  }
  requestCancelCoverageRun(coverageRunId);
  emit(coverageRunId);
}

/**
 * Request a pause. Takes effect at the next checkpoint — the current in-flight
 * step is allowed to finish (we never throw away in-flight LLM work).
 */
export function pauseCoverageRun(coverageRunId: string): void {
  const c = controls.get(coverageRunId);
  if (!c || c.cancelled) return;
  c.pauseRequested = true;
  emit(coverageRunId);
}

/** Resume a paused pass: continue the same closure from the exact next plan. */
export function resumeCoverageRun(coverageRunId: string): void {
  const c = controls.get(coverageRunId);
  if (!c) return; // no live closure (e.g. after restart) → cannot resume
  c.pauseRequested = false;
  c.wake?.();
}

/** Fail any pass left non-terminal by an app restart. Call once on startup. */
export function reconcileCoverageRuns(): number {
  return reconcileCoverageRunsDb();
}

/** Backend ground truth for whether a pass can run right now. */
export async function coverageLoopPreflight(
  repoId: string,
  depsOverride?: Partial<CoverageLoopDeps>,
): Promise<{ canRun: boolean; reason?: string }> {
  const repo = getRepo(repoId);
  if (!repo) return { canRun: false, reason: 'Repo not found.' };
  const deps: CoverageLoopDeps = { ...defaultDeps(), ...depsOverride };
  if (!(await deps.runnerAvailable())) {
    return {
      canRun: false,
      reason: 'Install Claude Code or Codex and make sure it is on your PATH.',
    };
  }
  return { canRun: true };
}

async function runPass(
  coverageRunId: string,
  repoId: string,
  opts: CoverageLoopOptions,
  deps: CoverageLoopDeps,
  control: LoopControl,
): Promise<void> {
  const run = getCoverageRun(coverageRunId);
  if (!run) return;
  const budget = run.budgetSpawns;
  const gapThreshold = run.gapThreshold;
  const trigger = run.trigger;
  const checkpointInterval = opts.checkpointInterval ?? HUNT_CHECKPOINT_INTERVAL;
  let spawnsUsed = run.spawnsUsed;

  const isCancelled = (): boolean => control.cancelled || isCancelRequested(coverageRunId);
  const finishCancelled = (): void => {
    advanceCoverageStage(coverageRunId, 'cancelled', 'Stopped by the user.');
    emit(coverageRunId);
  };

  /**
   * The single pause/cancel gate. Called at each loop boundary:
   *  - cancel → return 'cancelled' so the caller bails to finishCancelled().
   *  - pause  → park on a wake promise (the live closure, with its queue and
   *             spawnsUsed, stays intact), set stage 'paused' with a review
   *             summary, and on resume re-advance to the working stage.
   */
  const checkpoint = async (
    resumeStage: CoverageRunStage,
    resumeStatus: string,
    pauseStatus: string,
  ): Promise<'continue' | 'cancelled'> => {
    if (isCancelled()) return 'cancelled';
    if (control.pauseRequested) {
      advanceCoverageStage(coverageRunId, 'paused', pauseStatus);
      emit(coverageRunId);
      await new Promise<void>((resolve) => {
        control.wake = resolve;
      });
      control.wake = null;
      if (isCancelled()) return 'cancelled';
      advanceCoverageStage(coverageRunId, resumeStage, resumeStatus);
      emit(coverageRunId);
    }
    return 'continue';
  };

  const repo = getRepo(repoId);
  if (!repo) {
    failCoverageRun(coverageRunId, `Repo ${repoId} not found.`);
    emit(coverageRunId);
    return;
  }

  // Hard pre-flight: a pass can do nothing useful without a coding-agent CLI.
  if (!(await deps.runnerAvailable())) {
    failCoverageRun(
      coverageRunId,
      'No coding-agent CLI is installed.',
      'Install Claude Code or Codex and make sure it is on your PATH, then run the pass again.',
    );
    emit(coverageRunId);
    return;
  }

  /* ---------- Stage: mapping ---------- */
  advanceCoverageStage(coverageRunId, 'mapping', 'Mapping features in the repo…');
  emit(coverageRunId);
  let report = await deps.buildReport(repoId);

  if (!report.hasCoverageMap) {
    const stepId = appendCoverageStep({ coverageRunId, kind: 'map', state: 'running' });
    emit(coverageRunId);
    const jobId = deps.startMap({ repo, replace: true });
    spawnsUsed = incrementSpawns(coverageRunId);
    updateCoverageStep(stepId, { ref: jobId });
    const outcome = await deps.awaitMap(jobId, { signal: control.abort.signal });
    if (outcome.aborted || isCancelled()) {
      updateCoverageStep(stepId, { state: 'skipped' });
      return finishCancelled();
    }
    if (!outcome.ok) {
      updateCoverageStep(stepId, { state: 'failed', detail: outcome.errorMessage ?? null });
      failCoverageRun(
        coverageRunId,
        outcome.errorMessage ?? 'Could not map the repository.',
        outcome.errorHint ?? 'Try again, or generate the coverage map from the Coverage screen.',
      );
      emit(coverageRunId);
      return;
    }
    updateCoverageStep(stepId, { state: 'done' });
    emit(coverageRunId);
    report = await deps.buildReport(repoId);
  }

  if (isCancelled()) return finishCancelled();

  /* ---------- Stage: detecting ---------- */
  advanceCoverageStage(coverageRunId, 'detecting', 'Detecting coverage gaps…');
  emit(coverageRunId);
  const gaps = pickGaps(report, { threshold: gapThreshold });

  /* ---------- Stage: drafting ---------- */
  // Generate a plan ONLY for gaps that have no covering plan yet. This is the
  // intentional/deduped rule — it accumulates distinct plans over passes
  // instead of regenerating the same feature.
  advanceCoverageStage(
    coverageRunId,
    'drafting',
    gaps.length
      ? `Drafting plans for ${gaps.length} gap${gaps.length === 1 ? '' : 's'}…`
      : 'No gaps need a new plan.',
  );
  emit(coverageRunId);

  const needsPlan = gaps.filter((g) => g.planCount === 0);
  for (const gap of needsPlan) {
    if (spawnsUsed >= budget) break;
    if (
      (await checkpoint(
        'drafting',
        `Resuming — drafting a plan for ${gap.label}…`,
        'Paused. Resume to keep drafting the missing test plans.',
      )) === 'cancelled'
    ) {
      return finishCancelled();
    }

    const stepId = appendCoverageStep({
      coverageRunId,
      kind: 'generate',
      featureLabel: gap.label,
      state: 'running',
    });
    emit(coverageRunId);

    const jobId = deps.startGenerate({
      repo,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: gap.label,
      focusOnChangedOrUncovered: true,
    });
    spawnsUsed = incrementSpawns(coverageRunId);
    updateCoverageStep(stepId, { ref: jobId });

    const outcome = await deps.awaitGenerate(jobId, { signal: control.abort.signal });
    if (outcome.aborted) {
      updateCoverageStep(stepId, { state: 'skipped' });
      return finishCancelled();
    }
    // A junk/failed plan never sinks the pass — record it and move on.
    updateCoverageStep(stepId, {
      state: outcome.ok ? 'done' : 'failed',
      detail: outcome.ok ? null : (outcome.errorMessage ?? 'Generation failed.'),
    });
    emit(coverageRunId);
  }

  /* ---------- Stage: hunting ---------- */
  // Reload so the queue includes the plans we just drafted.
  report = await deps.buildReport(repoId);
  const queue = buildHuntQueue(report);
  advanceCoverageStage(
    coverageRunId,
    'hunting',
    queue.length
      ? `Running the Bug Hunter on ${queue.length} plan${queue.length === 1 ? '' : 's'}…`
      : 'No plans to hunt yet.',
  );
  emit(coverageRunId);

  let authAborted = false;
  let huntsRun = 0;
  let huntsSinceCheckpoint = 0;
  let totalFindings = 0;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    if (spawnsUsed >= budget) break;
    if (
      (await checkpoint(
        'hunting',
        `Resuming the Bug Hunter on ${item.label}…`,
        pausedSummary({ huntsRun, totalFindings, spawnsUsed, budget }),
      )) === 'cancelled'
    ) {
      return finishCancelled();
    }

    const stepId = appendCoverageStep({
      coverageRunId,
      kind: 'hunt',
      featureLabel: item.label,
      ref: `plan:${item.planId}`,
      state: 'running',
    });
    emit(coverageRunId);
    spawnsUsed = incrementSpawns(coverageRunId);
    control.activeHuntRunId = null;

    try {
      const result = await deps.runHunt({
        repoId,
        agentName: 'qa-hunter',
        taskId: `plan:${item.planId}`,
        trigger,
        // Capture the spawned run id the moment its row commits — before the
        // multi-minute CLI spawn — so Stop can abort it immediately and the
        // timeline row can deep-link to Mission Control.
        onStarted: ({ runId }) => {
          control.activeHuntRunId = runId;
          updateCoverageStep(stepId, { runId });
          emit(coverageRunId);
        },
        ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
      });
      // Auth expired mid-pass: pointless (and costly) to keep spawning. Abort.
      if (result.finalState === 'failed' && result.reason === 'auth_required') {
        updateCoverageStep(stepId, { state: 'failed', detail: 'Runner not signed in.' });
        failCoverageRun(
          coverageRunId,
          'The coding-agent CLI is not signed in.',
          'Run `claude login` (or `codex login`), then start the coverage pass again.',
        );
        emit(coverageRunId);
        authAborted = true;
        break;
      }
      const findings = result.runId ? countPreviewsForRun(result.runId) : 0;
      totalFindings += findings;
      updateCoverageStep(stepId, {
        state: huntStepState(result),
        detail: result.reason ?? null,
        runId: result.runId || null,
        findings,
      });
    } catch (e) {
      // Single-flight collision (a run for this plan is already live) or a
      // transient error — skip this plan, keep the pass going.
      updateCoverageStep(stepId, {
        state: 'skipped',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      control.activeHuntRunId = null;
    }
    emit(coverageRunId);

    huntsRun += 1;
    huntsSinceCheckpoint += 1;

    // Auto-checkpoint: on a MANUAL pass, pause for review after every N hunts
    // so the user sees what was found instead of the agent grinding silently
    // through the whole budget. Suppressed when we're about to stop anyway
    // (budget exhausted or queue finished) so a pass never ends stranded at
    // 'paused'. Scheduled passes run unattended (trigger !== 'manual').
    const moreQueue = i < queue.length - 1;
    if (
      trigger === 'manual' &&
      Number.isFinite(checkpointInterval) &&
      huntsSinceCheckpoint >= checkpointInterval &&
      spawnsUsed < budget &&
      moreQueue
    ) {
      control.pauseRequested = true;
      huntsSinceCheckpoint = 0;
    }
  }

  if (authAborted) return;
  if (isCancelled()) return finishCancelled();

  /* ---------- Done ---------- */
  const summary = passSummary({
    gapsTotal: gaps.length,
    drafted: needsPlan.length,
    hunted: huntsRun,
    found: totalFindings,
    spawnsUsed,
    budget,
  });
  advanceCoverageStage(coverageRunId, 'done', summary);
  emit(coverageRunId);
}

/** Review summary shown while a hunting pass is paused at a checkpoint. */
function pausedSummary(o: {
  huntsRun: number;
  totalFindings: number;
  spawnsUsed: number;
  budget: number;
}): string {
  const left = Math.max(0, o.budget - o.spawnsUsed);
  const hunted = `hunted ${o.huntsRun} plan${o.huntsRun === 1 ? '' : 's'}`;
  const found =
    o.totalFindings > 0
      ? `, found ${o.totalFindings} issue${o.totalFindings === 1 ? '' : 's'}`
      : ', no issues yet';
  return `Paused for review — ${hunted}${found}. Resume to continue (${left} of ${o.budget} budget left).`;
}

function huntStepState(result: RunAgentOutput): CoverageRunStepState {
  if (result.finalState === 'done') return 'done';
  if (result.finalState === 'cancelled') return 'skipped';
  return 'failed';
}

interface HuntItem {
  planId: string;
  label: string;
}

/**
 * Prioritized plan queue: worst-coverage features first, and within a feature
 * the most recently updated plan first (so a just-drafted plan hunts before
 * older ones). Whole-app plans come last. Over successive passes the budget
 * window walks the whole list, so every plan eventually runs — without firing
 * hundreds of runs in a single pass.
 */
export function buildHuntQueue(report: CoverageReport): HuntItem[] {
  const seen = new Set<string>();
  const queue: HuntItem[] = [];
  const features = [...report.features].sort((a, b) => a.coveragePct - b.coveragePct);
  for (const f of features) {
    const refs = [...f.planRefs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      queue.push({ planId: ref.id, label: f.label });
    }
  }
  for (const ref of report.wholeAppPlans) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    queue.push({ planId: ref.id, label: 'whole-app' });
  }
  return queue;
}

function passSummary(o: {
  gapsTotal: number;
  drafted: number;
  hunted: number;
  found: number;
  spawnsUsed: number;
  budget: number;
}): string {
  const parts: string[] = [];
  if (o.drafted > 0) parts.push(`drafted ${o.drafted} plan${o.drafted === 1 ? '' : 's'}`);
  if (o.hunted > 0) parts.push(`hunted ${o.hunted} plan${o.hunted === 1 ? '' : 's'}`);
  if (o.found > 0) parts.push(`found ${o.found} issue${o.found === 1 ? '' : 's'}`);
  const body = parts.length ? parts.join(', ') : 'no work needed';
  if (o.spawnsUsed >= o.budget) {
    return `Pass complete (${body}). Spawn budget reached — run again to continue.`;
  }
  if (o.gapsTotal === 0) {
    return `Pass complete — every feature is above the coverage threshold.`;
  }
  return `Pass complete (${body}).`;
}
