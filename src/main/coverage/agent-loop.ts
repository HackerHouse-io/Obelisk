import type {
  CoverageReport,
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
import { awaitCoverageMapJob, awaitTestPlanJob, type JobOutcome } from './loop-await';
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

export interface CoverageLoopOptions {
  trigger?: CoverageRunTrigger;
  gapThreshold?: number;
  budgetSpawns?: number;
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
  awaitMap: (jobId: string) => Promise<JobOutcome>;
  startGenerate: (input: GenerateInput) => string;
  awaitGenerate: (jobId: string) => Promise<JobOutcome>;
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

  const deps: CoverageLoopDeps = { ...defaultDeps(), ...depsOverride };
  void runPass(run.id, repoId, opts, deps).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    failCoverageRun(run.id, message);
    emit(run.id);
  });
  return run.id;
}

export function cancelCoverageRun(coverageRunId: string): void {
  requestCancelCoverageRun(coverageRunId);
  emit(coverageRunId);
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
): Promise<void> {
  const run = getCoverageRun(coverageRunId);
  if (!run) return;
  const budget = run.budgetSpawns;
  const gapThreshold = run.gapThreshold;
  const trigger = run.trigger;
  let spawnsUsed = run.spawnsUsed;

  const cancelled = (): boolean => isCancelRequested(coverageRunId);
  const finishCancelled = (): void => {
    advanceCoverageStage(coverageRunId, 'cancelled', 'Cancelled by the user.');
    emit(coverageRunId);
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
    const outcome = await deps.awaitMap(jobId);
    if (cancelled()) {
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

  if (cancelled()) return finishCancelled();

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
    if (cancelled()) return finishCancelled();

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

    const outcome = await deps.awaitGenerate(jobId);
    // A junk/failed plan never sinks the pass — record it and move on.
    updateCoverageStep(stepId, {
      state: outcome.ok ? 'done' : 'failed',
      detail: outcome.ok ? null : (outcome.errorMessage ?? 'Generation failed.'),
    });
    emit(coverageRunId);

    if (cancelled()) return finishCancelled();
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
  for (const item of queue) {
    if (spawnsUsed >= budget) break;
    if (cancelled()) return finishCancelled();

    const stepId = appendCoverageStep({
      coverageRunId,
      kind: 'hunt',
      featureLabel: item.label,
      ref: `plan:${item.planId}`,
      state: 'running',
    });
    emit(coverageRunId);
    spawnsUsed = incrementSpawns(coverageRunId);

    try {
      const result = await deps.runHunt({
        repoId,
        agentName: 'qa-hunter',
        taskId: `plan:${item.planId}`,
        trigger,
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
      updateCoverageStep(stepId, {
        state: huntStepState(result),
        detail: result.reason ?? null,
      });
    } catch (e) {
      // Single-flight collision (a run for this plan is already live) or a
      // transient error — skip this plan, keep the pass going.
      updateCoverageStep(stepId, {
        state: 'skipped',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    emit(coverageRunId);
  }

  if (authAborted) return;
  if (cancelled()) return finishCancelled();

  /* ---------- Done ---------- */
  const summary = passSummary({
    gapsTotal: gaps.length,
    drafted: needsPlan.length,
    hunted: queue.length,
    spawnsUsed,
    budget,
  });
  advanceCoverageStage(coverageRunId, 'done', summary);
  emit(coverageRunId);
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
  spawnsUsed: number;
  budget: number;
}): string {
  const parts: string[] = [];
  if (o.drafted > 0) parts.push(`drafted ${o.drafted} plan${o.drafted === 1 ? '' : 's'}`);
  if (o.hunted > 0) parts.push(`hunted ${o.hunted} plan${o.hunted === 1 ? '' : 's'}`);
  const body = parts.length ? parts.join(', ') : 'no work needed';
  if (o.spawnsUsed >= o.budget) {
    return `Pass complete (${body}). Spawn budget reached — run again to continue.`;
  }
  if (o.gapsTotal === 0) {
    return `Pass complete — every feature is above the coverage threshold.`;
  }
  return `Pass complete (${body}).`;
}
