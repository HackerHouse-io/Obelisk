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
