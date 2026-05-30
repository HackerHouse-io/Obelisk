import { describe, expect, it } from 'vitest';
import { pickGaps } from '../../src/shared/coverage-formula';
import type { CoverageFeature, CoverageReport } from '../../src/shared/types';

function feature(label: string, pct: number, over: Partial<CoverageFeature> = {}): CoverageFeature {
  return {
    label,
    planCount: 0,
    caseCount: 0,
    casesPassed: 0,
    filesInGlob: 3,
    filesWithCases: 0,
    filesRecentPass: 0,
    openFindings: 0,
    coveragePct: pct,
    planRefs: [],
    files: [],
    ...over,
  };
}

function report(features: CoverageFeature[], staleLabels: string[] = []): CoverageReport {
  return {
    repoId: 'r1',
    files: [],
    features,
    wholeAppPlans: [],
    staleLabels,
    hasCoverageMap: true,
    totalFiles: 0,
    coveredFiles: 0,
    uncoveredFiles: 0,
    lastDoneAt: null,
  };
}

describe('pickGaps', () => {
  it('returns only features below the threshold', () => {
    const r = report([feature('a', 90), feature('b', 40), feature('c', 69)]);
    const gaps = pickGaps(r, { threshold: 70 });
    expect(gaps.map((g) => g.label)).toEqual(['b', 'c']);
  });

  it('orders worst coverage first, then most cases', () => {
    const r = report([
      feature('a', 50, { caseCount: 2 }),
      feature('b', 10),
      feature('c', 50, { caseCount: 9 }),
    ]);
    const gaps = pickGaps(r, { threshold: 70 });
    // b (10%) first; then the two at 50% ordered by caseCount desc → c, a.
    expect(gaps.map((g) => g.label)).toEqual(['b', 'c', 'a']);
  });

  it('excludes stale labels', () => {
    const r = report([feature('a', 10), feature('ghost', 0)], ['ghost']);
    const gaps = pickGaps(r, { threshold: 70 });
    expect(gaps.map((g) => g.label)).toEqual(['a']);
  });

  it('excludes zero-file labels', () => {
    const r = report([feature('a', 10), feature('empty', 0, { filesInGlob: 0 })]);
    const gaps = pickGaps(r, { threshold: 70 });
    expect(gaps.map((g) => g.label)).toEqual(['a']);
  });

  it('caps the result at max', () => {
    const r = report([
      feature('a', 1),
      feature('b', 2),
      feature('c', 3),
      feature('d', 4),
    ]);
    expect(pickGaps(r, { threshold: 70, max: 2 })).toHaveLength(2);
  });

  it('defaults threshold to 70 and max to 6', () => {
    const features = Array.from({ length: 10 }, (_, i) => feature(`f${i}`, i));
    expect(pickGaps(report(features))).toHaveLength(6);
  });
});
