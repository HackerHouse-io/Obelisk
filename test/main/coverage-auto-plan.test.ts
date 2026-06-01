import { describe, expect, it } from 'vitest';
import {
  resolveLeastCoveredPlan,
  type AutoPlanDeps,
} from '../../src/main/coverage/auto-plan';
import type { CoverageFeature, CoverageReport, Repo, TestPlanRef } from '../../src/shared/types';

const repo = { id: 'repo1', localPath: '/tmp/repo1' } as unknown as Repo;

function planRef(id: string, updatedAt = '2026-01-01T00:00:00Z'): TestPlanRef {
  return { id, name: id, agentNames: ['qa-hunter'], updatedAt };
}

function feature(
  label: string,
  pct: number,
  over: Partial<CoverageFeature> = {},
): CoverageFeature {
  return {
    label,
    planCount: over.planRefs?.length ?? 0,
    caseCount: 0,
    casesPassed: 0,
    filesInGlob: 2,
    filesWithCases: 0,
    filesRecentPass: 0,
    openFindings: 0,
    coveragePct: pct,
    planRefs: [],
    files: [],
    ...over,
  };
}

function report(features: CoverageFeature[]): CoverageReport {
  return {
    repoId: repo.id,
    files: [],
    features,
    wholeAppPlans: [],
    staleLabels: [],
    hasCoverageMap: true,
    totalFiles: 0,
    coveredFiles: 0,
    uncoveredFiles: 0,
    lastDoneAt: null,
  };
}

interface Calls {
  maps: number;
  generated: string[];
  fallback: number;
}

function mkDeps(
  over: Partial<AutoPlanDeps> = {},
): { deps: Partial<AutoPlanDeps>; calls: Calls } {
  const calls: Calls = { maps: 0, generated: [], fallback: 0 };
  const deps: Partial<AutoPlanDeps> = {
    loadMap: () =>
      new Map<string, string[]>([
        ['auth', ['src/auth/**']],
        ['checkout', ['src/checkout/**']],
      ]),
    buildReport: async () => report([]),
    startMap: () => {
      calls.maps += 1;
      return 'map-job';
    },
    awaitMap: async () => ({ ok: true }),
    startGenerate: (input) => {
      calls.generated.push(input.featureName ?? '');
      return `gen-${input.featureName}`;
    },
    awaitGenerate: async () => ({ ok: true, planId: 'p-new' }),
    fallbackPick: async () => {
      calls.fallback += 1;
      return 'fallback-plan';
    },
    ...over,
  };
  return { deps, calls };
}

describe('resolveLeastCoveredPlan', () => {
  it('returns the newest qa-hunter plan of the lowest-coverage map feature', async () => {
    const { deps } = mkDeps({
      buildReport: async () =>
        report([
          feature('auth', 80, { planRefs: [planRef('auth-plan')] }),
          feature('checkout', 20, {
            planRefs: [
              planRef('checkout-old', '2026-01-01T00:00:00Z'),
              planRef('checkout-new', '2026-02-01T00:00:00Z'),
            ],
          }),
        ]),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(r.planId).toBe('checkout-new');
    expect(r.featureLabel).toBe('checkout');
    expect(r.generated).toBe(false);
  });

  it('ignores features not in the coverage map even when they are worst', async () => {
    const { deps, calls } = mkDeps({
      buildReport: async () =>
        report([
          // Lowest coverage, but NOT a map label (a stray scanner bucket).
          feature('src', 5, { planRefs: [planRef('src-plan')] }),
          feature('auth', 40, { planRefs: [planRef('auth-plan')] }),
        ]),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(r.planId).toBe('auth-plan');
    expect(r.featureLabel).toBe('auth');
    expect(calls.fallback).toBe(0);
  });

  it('is deterministic when all features are at zero (label asc tiebreaker)', async () => {
    const make = () =>
      mkDeps({
        buildReport: async () =>
          report([
            feature('checkout', 0, { planRefs: [planRef('checkout-plan')] }),
            feature('auth', 0, { planRefs: [planRef('auth-plan')] }),
          ]),
      }).deps;
    const a = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, make());
    const b = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, make());
    expect(a.featureLabel).toBe('auth'); // 'auth' < 'checkout'
    expect(a.planId).toBe('auth-plan');
    expect(b.featureLabel).toBe(a.featureLabel);
  });

  it('preview (generate:false) flags a missing map without spawning', async () => {
    const { deps, calls } = mkDeps({ loadMap: () => new Map() });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: false }, deps);
    expect(r.willGenerateMap).toBe(true);
    expect(r.planId).toBeNull();
    expect(calls.maps).toBe(0);
  });

  it('generate:true with no map generates the map first, then proceeds', async () => {
    let mapped = false;
    const { deps, calls } = mkDeps({
      loadMap: () => (mapped ? new Map([['auth', ['src/auth/**']]]) : new Map()),
      startMap: () => {
        mapped = true;
        return 'map-job';
      },
      awaitMap: async () => ({ ok: true }),
      buildReport: async () => report([feature('auth', 10, { planRefs: [planRef('auth-plan')] })]),
    });
    // Patch the startMap counter through after our custom one.
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(calls.generated).toEqual([]); // plan already existed
    expect(r.planId).toBe('auth-plan');
  });

  it('map generation failure surfaces an error (drives auto-pause)', async () => {
    const { deps } = mkDeps({
      loadMap: () => new Map(),
      awaitMap: async () => ({ ok: false, errorMessage: 'map boom', errorHint: 'retry' }),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(r.planId).toBeNull();
    expect(r.error?.message).toBe('map boom');
    expect(r.error?.hint).toBe('retry');
  });

  it('generates a feature-scoped plan when the worst feature has none', async () => {
    const { deps, calls } = mkDeps({
      buildReport: async () => report([feature('checkout', 0)]), // no planRefs
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(calls.generated).toEqual(['checkout']);
    expect(r.planId).toBe('p-new');
    expect(r.featureLabel).toBe('checkout');
    expect(r.generated).toBe(true);
  });

  it('passes the right generation input (feature scope + focus)', async () => {
    let captured: { scope?: string; featureName?: string; focus?: boolean } = {};
    const { deps } = mkDeps({
      buildReport: async () => report([feature('checkout', 0)]),
      startGenerate: (input) => {
        captured = {
          scope: input.scope,
          ...(input.featureName !== undefined ? { featureName: input.featureName } : {}),
          focus: input.focusOnChangedOrUncovered,
        };
        return 'gen-job';
      },
    });
    await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(captured.scope).toBe('feature');
    expect(captured.featureName).toBe('checkout');
    expect(captured.focus).toBe(true);
  });

  it('plan generation failure surfaces an error', async () => {
    const { deps } = mkDeps({
      buildReport: async () => report([feature('checkout', 0)]),
      awaitGenerate: async () => ({ ok: false, errorMessage: 'gen boom' }),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(r.planId).toBeNull();
    expect(r.error?.message).toBe('gen boom');
  });

  it('aborting the wait yields no plan and no error (no auto-pause)', async () => {
    const { deps } = mkDeps({
      buildReport: async () => report([feature('checkout', 0)]),
      awaitGenerate: async () => ({ ok: false, aborted: true }),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(r.planId).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it('falls back to pickWorstCoveragePlanId when there is no coverage map', async () => {
    const { deps, calls } = mkDeps({
      loadMap: () => new Map(),
      // map generation succeeds but still yields an empty map → fallback.
      awaitMap: async () => ({ ok: true }),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(calls.fallback).toBe(1);
    expect(r.planId).toBe('fallback-plan');
  });

  it('falls back when no map-backed feature surfaces in the report', async () => {
    const { deps, calls } = mkDeps({
      buildReport: async () => report([feature('legacy-bucket', 0)]), // not a map label
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: true }, deps);
    expect(calls.fallback).toBe(1);
    expect(r.planId).toBe('fallback-plan');
  });

  it('preview flags plan generation for a planless worst feature without spawning', async () => {
    const { deps, calls } = mkDeps({
      buildReport: async () => report([feature('checkout', 0)]),
    });
    const r = await resolveLeastCoveredPlan(repo, 'qa-hunter', { generate: false }, deps);
    expect(r.willGeneratePlan).toBe(true);
    expect(r.featureLabel).toBe('checkout');
    expect(r.planId).toBeNull();
    expect(calls.generated).toEqual([]);
  });
});
