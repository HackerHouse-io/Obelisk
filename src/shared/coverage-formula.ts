/**
 * Pure helpers for the Coverage radar chart and feature-card UI.
 *
 * The composite `coveragePct` is the score that drives the radar polygon
 * (and the big % on each feature card). It captures three signals plus an
 * unresolved-bug penalty:
 *
 *   fileScore      — how much of the feature's surface has any case at all
 *   freshnessScore — how much of the cased surface has a recent passing run
 *   caseScore      — fraction of the feature's cases that passed in the
 *                    most recent done run of each plan
 *   findingsDrag   — penalty for open findings tagged to feature files
 *
 * The main process exports this in `aggregate.ts` so both ends agree on
 * the number.
 */

export interface FeatureInputs {
  filesInGlob: number;
  filesWithCases: number;
  filesRecentPass: number;
  caseCount: number;
  casesPassed: number;
  openFindings: number;
}

export interface FeatureScoreBreakdown {
  fileScore: number;
  freshnessScore: number;
  caseScore: number;
  findingsDrag: number;
  coveragePct: number;
}

import type { CoverageFeature, CoverageReport, CoverageRunStage } from './types';

/** The stages a coverage pass can end in. Shared so main + renderer agree. */
export const COVERAGE_TERMINAL_STAGES: ReadonlySet<CoverageRunStage> = new Set([
  'done',
  'failed',
  'cancelled',
]);

export function isCoverageRunTerminal(stage: CoverageRunStage): boolean {
  return COVERAGE_TERMINAL_STAGES.has(stage);
}

export interface PickGapsOptions {
  /** Features whose coveragePct is below this (0..100) are gaps. Default 70. */
  threshold?: number;
  /** Hard cap on how many gaps a single pass works. Default 6. */
  max?: number;
}

/**
 * Pick the features the Coverage Agent should work this pass, worst-first.
 *
 * A "gap" is a real feature scoring below `threshold`. We exclude:
 *   - stale labels (referenced by a case but matching zero tracked files) —
 *     working them would chase a phantom, and the user fixes those by
 *     editing `qa/coverage-map.md`.
 *   - zero-file labels (`filesInGlob === 0`) for the same reason.
 *
 * Ordering: lowest coverage first, then most cases (a feature with cases that
 * are failing/stale is a more urgent gap than one that was never touched but
 * is tiny). Capped at `max` so a single pass stays bounded on big repos.
 *
 * Pure + shared so both the loop and its unit tests agree on the selection.
 */
export function pickGaps(report: CoverageReport, opts: PickGapsOptions = {}): CoverageFeature[] {
  const threshold = opts.threshold ?? 70;
  const max = opts.max ?? 6;
  const stale = new Set(report.staleLabels.map((l) => l.toLowerCase()));
  return report.features
    .filter((f) => f.filesInGlob > 0)
    .filter((f) => !stale.has(f.label.toLowerCase()))
    .filter((f) => f.coveragePct < threshold)
    .sort((a, b) => a.coveragePct - b.coveragePct || b.caseCount - a.caseCount)
    .slice(0, Math.max(0, max));
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function computeFeatureScore(input: FeatureInputs): FeatureScoreBreakdown {
  const fileScore = input.filesInGlob > 0 ? input.filesWithCases / input.filesInGlob : 0;
  const freshnessScore =
    input.filesWithCases > 0 ? input.filesRecentPass / input.filesWithCases : 0;
  const caseScore = input.caseCount > 0 ? input.casesPassed / input.caseCount : 0;
  const findingsDrag = Math.min(0.3, Math.max(0, input.openFindings) * 0.05);

  const raw = 0.4 * fileScore + 0.3 * freshnessScore + 0.3 * caseScore - findingsDrag;
  const coveragePct = Math.round(100 * clamp01(raw));

  return {
    fileScore: round2(fileScore),
    freshnessScore: round2(freshnessScore),
    caseScore: round2(caseScore),
    findingsDrag: round2(findingsDrag),
    coveragePct,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Project a list of axis values (0..100) onto a regular polygon's vertices
 * around `(cx, cy)` with the given `radius`. Returns SVG `points`-style
 * pairs `[x, y][]` in axis order (clockwise from straight up).
 */
export function polygonPoints(
  values: number[],
  cx: number,
  cy: number,
  radius: number,
): [number, number][] {
  const n = values.length;
  if (n === 0) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const v = clamp01((values[i] ?? 0) / 100);
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push([cx + Math.cos(angle) * radius * v, cy + Math.sin(angle) * radius * v]);
  }
  return out;
}

/**
 * Same as `polygonPoints` but at full radius, regardless of value. Used
 * for axis spokes and the concentric grid polygons.
 */
export function axisVertices(
  count: number,
  cx: number,
  cy: number,
  radius: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    out.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return out;
}

export function toSvgPath(points: [number, number][]): string {
  return points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}
