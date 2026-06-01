import type { AgentName, CoverageReport, Repo } from '../../shared/types';
import { buildCoverageReport } from './aggregate';
import { loadCoverageMap } from './coverage-map';
import { startMapGenerationJob, type GenerateMapInput } from './generate-map';
import { startGenerationJob, type GenerateInput } from '../test-plans/generate';
import {
  awaitCoverageMapJob,
  awaitTestPlanJob,
  type AwaitJobOptions,
  type JobOutcome,
} from './loop-await';
import { pickWorstCoveragePlanId } from './pick-plan';

/**
 * Resolve which test plan a QA agent should run when it is in
 * `planSelectionMode: 'least-covered'`. Unlike `pickWorstCoveragePlanId` (which
 * only returns an EXISTING plan), this targets the lowest-coverage feature
 * regardless of whether it has a plan yet — generating the coverage map and/or
 * a feature-scoped test plan first when none exists.
 *
 * It owns no CLI of its own; like the Coverage Agent loop it SEQUENCES proven
 * primitives (map generation, plan generation, the coverage report) so it
 * inherits their timeouts, single-flight (the test-plan job tracker dedups by
 * repo+scope+agent+feature), and parsing.
 *
 * Two modes via `opts.generate`:
 *   - `false` (preview): never spawns. Reports what it WOULD do via
 *     `willGenerateMap` / `willGeneratePlan` so the Run-now confirm modal can
 *     warn the user about a multi-minute operation.
 *   - `true` (execute): generates map/plan as needed and returns the concrete
 *     `planId` to dispatch. Used by the scheduler (unattended) and by the
 *     manual prepare-and-run path (after the user accepts the modal).
 */
export interface AutoPlanResult {
  /** Concrete plan id to dispatch, or null when none could be resolved. */
  planId: string | null;
  /** The feature this run targets (null until a coverage map exists). */
  featureLabel: string | null;
  /** Preview signal: a coverage map would be generated first. */
  willGenerateMap: boolean;
  /** Preview signal: a test plan would be generated for `featureLabel`. */
  willGeneratePlan: boolean;
  /** True when a plan was actually generated during this call (`generate:true`). */
  generated: boolean;
  /** Set when generation failed (not aborted) — drives auto-pause / error toast. */
  error?: { message: string; hint?: string };
}

export interface ResolveOptions {
  /** When true, actually spawn map/plan generation; when false, preview only. */
  generate: boolean;
  /**
   * Aborts WAITING on a generation job (the job itself keeps running). On abort
   * the result has `planId:null` and no `error`, so callers don't auto-pause.
   */
  signal?: AbortSignal;
}

/** Seam for unit tests — production uses the real implementations. */
export interface AutoPlanDeps {
  buildReport: (repoId: string) => Promise<CoverageReport>;
  loadMap: (repoPath: string) => Map<string, string[]>;
  startMap: (input: GenerateMapInput) => string;
  awaitMap: (jobId: string, opts?: AwaitJobOptions) => Promise<JobOutcome>;
  startGenerate: (input: GenerateInput) => string;
  awaitGenerate: (jobId: string, opts?: AwaitJobOptions) => Promise<JobOutcome>;
  fallbackPick: (repo: Repo, agentName: AgentName) => Promise<string | null>;
}

function defaultAutoPlanDeps(): AutoPlanDeps {
  return {
    buildReport: buildCoverageReport,
    loadMap: loadCoverageMap,
    startMap: startMapGenerationJob,
    awaitMap: awaitCoverageMapJob,
    startGenerate: startGenerationJob,
    awaitGenerate: awaitTestPlanJob,
    fallbackPick: pickWorstCoveragePlanId,
  };
}

const EMPTY: AutoPlanResult = {
  planId: null,
  featureLabel: null,
  willGenerateMap: false,
  willGeneratePlan: false,
  generated: false,
};

export async function resolveLeastCoveredPlan(
  repo: Repo,
  agentName: AgentName,
  opts: ResolveOptions,
  depsOverride?: Partial<AutoPlanDeps>,
): Promise<AutoPlanResult> {
  const deps = { ...defaultAutoPlanDeps(), ...depsOverride };
  const awaitOpts: AwaitJobOptions = opts.signal ? { signal: opts.signal } : {};

  // 1. Map gate (full autonomy). The coverage map is the canonical feature
  //    taxonomy; without it we'd target stray scanner buckets.
  let map = deps.loadMap(repo.localPath);
  if (map.size === 0) {
    if (!opts.generate) return { ...EMPTY, willGenerateMap: true };
    const jobId = deps.startMap({ repo, replace: true });
    const outcome = await deps.awaitMap(jobId, awaitOpts);
    if (outcome.aborted) return { ...EMPTY };
    if (!outcome.ok) return { ...EMPTY, error: jobError(outcome, 'Could not map the repository.') };
    map = deps.loadMap(repo.localPath);
    // Mapping produced nothing usable — fall back to existing plans.
    if (map.size === 0) return { ...EMPTY, planId: await deps.fallbackPick(repo, agentName) };
  }

  // 2. Build the coverage report.
  let report: CoverageReport;
  try {
    report = await deps.buildReport(repo.id);
  } catch {
    return { ...EMPTY, planId: await deps.fallbackPick(repo, agentName) };
  }

  // 3. Restrict to map labels and sort worst-first, deterministically. The
  //    explicit `label asc` tiebreaker makes the all-zero case stable instead
  //    of depending on coverage-map insertion order.
  const mapLabels = new Set([...map.keys()].map((l) => l.toLowerCase()));
  const candidates = report.features
    .filter((f) => mapLabels.has(f.label.toLowerCase()))
    .sort((a, b) => {
      if (a.coveragePct !== b.coveragePct) return a.coveragePct - b.coveragePct;
      if (a.caseCount !== b.caseCount) return b.caseCount - a.caseCount;
      return a.label.localeCompare(b.label);
    });

  // 4. No map-backed feature surfaced (e.g. all globs broken) — fall back.
  if (candidates.length === 0) {
    return { ...EMPTY, planId: await deps.fallbackPick(repo, agentName) };
  }

  // 5. The least-covered feature.
  const worst = candidates[0]!;
  const existing = worst.planRefs
    .filter((p) => p.agentNames.includes(agentName))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (existing) {
    return { ...EMPTY, planId: existing.id, featureLabel: worst.label };
  }

  // No plan for the worst feature yet.
  if (!opts.generate) {
    return { ...EMPTY, featureLabel: worst.label, willGeneratePlan: true };
  }

  const jobId = deps.startGenerate({
    repo,
    agentName,
    scope: 'feature',
    featureName: worst.label,
    focusOnChangedOrUncovered: true,
  });
  const outcome = await deps.awaitGenerate(jobId, awaitOpts);
  if (outcome.aborted) {
    return { ...EMPTY, featureLabel: worst.label, willGeneratePlan: true };
  }
  if (!outcome.ok || !outcome.planId) {
    return {
      ...EMPTY,
      featureLabel: worst.label,
      willGeneratePlan: true,
      error: jobError(outcome, 'Could not generate a test plan.'),
    };
  }
  return { ...EMPTY, planId: outcome.planId, featureLabel: worst.label, generated: true };
}

function jobError(outcome: JobOutcome, fallback: string): { message: string; hint?: string } {
  return {
    message: outcome.errorMessage ?? fallback,
    ...(outcome.errorHint ? { hint: outcome.errorHint } : {}),
  };
}
