import { describe, it, expect } from 'vitest';
import {
  axisVertices,
  clamp01,
  computeFeatureScore,
  polygonPoints,
  toSvgPath,
} from '../../src/shared/coverage-formula';

describe('clamp01', () => {
  it('clamps below 0', () => {
    expect(clamp01(-0.1)).toBe(0);
  });
  it('clamps above 1', () => {
    expect(clamp01(1.5)).toBe(1);
  });
  it('treats NaN as 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
  it('passes through valid values', () => {
    expect(clamp01(0.42)).toBe(0.42);
  });
});

describe('computeFeatureScore', () => {
  it('returns 0 across the board when nothing exists', () => {
    const r = computeFeatureScore({
      filesInGlob: 0,
      filesWithCases: 0,
      filesRecentPass: 0,
      caseCount: 0,
      casesPassed: 0,
      openFindings: 0,
    });
    expect(r.coveragePct).toBe(0);
    expect(r.fileScore).toBe(0);
    expect(r.caseScore).toBe(0);
  });

  it('files alone get to ~40% (no freshness, no case passes yet)', () => {
    const r = computeFeatureScore({
      filesInGlob: 10,
      filesWithCases: 10,
      filesRecentPass: 0,
      caseCount: 0,
      casesPassed: 0,
      openFindings: 0,
    });
    // fileScore = 1.0 * 0.40 = 40
    expect(r.coveragePct).toBe(40);
  });

  it('all-pass / all-fresh / all-files lands at 100', () => {
    const r = computeFeatureScore({
      filesInGlob: 5,
      filesWithCases: 5,
      filesRecentPass: 5,
      caseCount: 12,
      casesPassed: 12,
      openFindings: 0,
    });
    expect(r.coveragePct).toBe(100);
  });

  it('findings drag is capped at -30pt', () => {
    const r = computeFeatureScore({
      filesInGlob: 5,
      filesWithCases: 5,
      filesRecentPass: 5,
      caseCount: 5,
      casesPassed: 5,
      openFindings: 100, // would be 5pt × 100 = 500 if uncapped
    });
    // 100 - 30 cap = 70
    expect(r.coveragePct).toBe(70);
  });

  it('clamps the composite — heavy findings can drive score to 0 but not negative', () => {
    const r = computeFeatureScore({
      filesInGlob: 10,
      filesWithCases: 0,
      filesRecentPass: 0,
      caseCount: 0,
      casesPassed: 0,
      openFindings: 50,
    });
    expect(r.coveragePct).toBe(0);
  });

  it('halfway results: half files cased + half passed', () => {
    const r = computeFeatureScore({
      filesInGlob: 10,
      filesWithCases: 5,
      filesRecentPass: 0,
      caseCount: 10,
      casesPassed: 5,
      openFindings: 0,
    });
    // 0.40 * 0.5 + 0.30 * 0 + 0.30 * 0.5 = 0.20 + 0.15 = 0.35 → 35
    expect(r.coveragePct).toBe(35);
  });
});

describe('polygonPoints + axisVertices', () => {
  it('returns N points for N axes', () => {
    const pts = polygonPoints([50, 50, 50, 50], 100, 100, 80);
    expect(pts).toHaveLength(4);
  });

  it('value=100 lands on the outer ring', () => {
    const pts = polygonPoints([100], 100, 100, 80);
    // First axis points straight up → y = cy - radius = 20
    expect(pts[0]?.[0]).toBeCloseTo(100, 5);
    expect(pts[0]?.[1]).toBeCloseTo(20, 5);
  });

  it('value=0 collapses to the center', () => {
    const pts = polygonPoints([0, 0, 0], 100, 100, 80);
    for (const p of pts) {
      expect(p[0]).toBeCloseTo(100, 5);
      expect(p[1]).toBeCloseTo(100, 5);
    }
  });

  it('axisVertices always at full radius', () => {
    const verts = axisVertices(6, 100, 100, 80);
    expect(verts).toHaveLength(6);
    // First vertex at top
    expect(verts[0]?.[0]).toBeCloseTo(100, 5);
    expect(verts[0]?.[1]).toBeCloseTo(20, 5);
  });
});

describe('toSvgPath', () => {
  it('joins x,y pairs with spaces and rounds to 1dp', () => {
    expect(toSvgPath([[1.234, 5.678], [10.0, 20.0]])).toBe('1.2,5.7 10.0,20.0');
  });
});
