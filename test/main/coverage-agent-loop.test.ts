import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { getActiveCoverageRun, getCoverageRun } from '../../src/main/db/coverage-runs';
import { insertPreview } from '../../src/main/db/previews';
import { createRun } from '../../src/main/db/runs';
import {
  clearActiveRunsForTesting,
  registerRun,
} from '../../src/main/orchestrator/active-runs';
import {
  buildHuntQueue,
  cancelCoverageRun,
  pauseCoverageRun,
  resumeCoverageRun,
  startCoverageRun,
  type CoverageLoopDeps,
} from '../../src/main/coverage/agent-loop';
import type { CoverageFeature, CoverageReport, CoverageRunSummary } from '../../src/shared/types';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-covloop-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/loop',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
});

afterEach(() => {
  clearActiveRunsForTesting();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/* ---------- fixtures ---------- */

function feature(label: string, pct: number, over: Partial<CoverageFeature> = {}): CoverageFeature {
  return {
    label,
    planCount: 0,
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

function report(features: CoverageFeature[], over: Partial<CoverageReport> = {}): CoverageReport {
  return {
    repoId,
    files: [],
    features,
    wholeAppPlans: [],
    staleLabels: [],
    hasCoverageMap: true,
    totalFiles: 0,
    coveredFiles: 0,
    uncoveredFiles: 0,
    lastDoneAt: null,
    ...over,
  };
}

function planRef(id: string, updatedAt = '2026-01-01T00:00:00Z') {
  return { id, name: id, agentNames: ['qa-hunter' as const], updatedAt };
}

interface Calls {
  generated: string[];
  hunted: string[];
  maps: number;
}

function makeDeps(reports: CoverageReport[], over: Partial<CoverageLoopDeps> = {}): {
  deps: Partial<CoverageLoopDeps>;
  calls: Calls;
} {
  const calls: Calls = { generated: [], hunted: [], maps: 0 };
  const queue = [...reports];
  const deps: Partial<CoverageLoopDeps> = {
    runnerAvailable: async () => true,
    buildReport: async () => queue.shift() ?? reports[reports.length - 1]!,
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
    runHunt: async (input) => {
      calls.hunted.push(input.taskId ?? '');
      return { runId: 'r1', finalState: 'done', reason: 'previewed' };
    },
    ...over,
  };
  return { deps, calls };
}

async function waitForTerminal(id: string, timeoutMs = 3000): Promise<CoverageRunSummary> {
  const start = Date.now();
  for (;;) {
    const run = getCoverageRun(id);
    if (run && ['done', 'failed', 'cancelled'].includes(run.stage)) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`pass ${id} did not finish: ${run?.stage}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Poll until the run reaches a specific (possibly non-terminal) stage. */
async function waitForStage(
  id: string,
  stage: CoverageRunSummary['stage'],
  timeoutMs = 3000,
): Promise<CoverageRunSummary> {
  const start = Date.now();
  for (;;) {
    const run = getCoverageRun(id);
    if (run && run.stage === stage) return run;
    if (Date.now() - start > timeoutMs)
      throw new Error(`pass ${id} never reached ${stage}: ${run?.stage}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Poll until at least one timeline step matches the predicate. */
async function waitForStep(
  id: string,
  pred: (s: CoverageRunSummary['steps'][number]) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const run = getCoverageRun(id);
    if (run && run.steps.some(pred)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`pass ${id} step never matched`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ---------- tests ---------- */

describe('Coverage Agent loop', () => {
  it('drafts a plan for a gap, then hunts it', async () => {
    const { deps, calls } = makeDeps([
      // mapping/detecting snapshot: checkout is a dark gap with no plan.
      report([feature('checkout', 0)]),
      // hunting snapshot: the just-drafted plan now exists.
      report([feature('checkout', 0, { planCount: 1, planRefs: [planRef('p-new')] })]),
    ]);
    const id = startCoverageRun(repoId, {}, deps);
    const run = await waitForTerminal(id);

    expect(run.stage).toBe('done');
    expect(calls.generated).toEqual(['checkout']);
    expect(calls.hunted).toEqual(['plan:p-new']);
    const kinds = run.steps.map((s) => `${s.kind}:${s.state}`);
    expect(kinds).toContain('generate:done');
    expect(kinds).toContain('hunt:done');
  });

  it('does NOT regenerate a feature that already has a plan', async () => {
    const covered = report([feature('auth', 30, { planCount: 1, planRefs: [planRef('p1')] })]);
    const { deps, calls } = makeDeps([covered, covered]);
    const id = startCoverageRun(repoId, {}, deps);
    await waitForTerminal(id);
    expect(calls.generated).toEqual([]); // deduped — no new plan
    expect(calls.hunted).toEqual(['plan:p1']); // but still hunted
  });

  it('respects the spawn budget', async () => {
    const gaps = report(
      Array.from({ length: 10 }, (_, i) => feature(`f${i}`, i)),
    );
    const { deps } = makeDeps([gaps, gaps]);
    const id = startCoverageRun(repoId, { budgetSpawns: 3 }, deps);
    const run = await waitForTerminal(id);
    expect(run.spawnsUsed).toBeLessThanOrEqual(3);
    expect(run.stage).toBe('done');
  });

  it('continues past a failed plan generation', async () => {
    const { deps, calls } = makeDeps(
      [report([feature('checkout', 0), feature('billing', 0)]), report([])],
      { awaitGenerate: async () => ({ ok: false, errorMessage: 'model returned junk' }) },
    );
    const id = startCoverageRun(repoId, {}, deps);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('done'); // one bad gap doesn't sink the pass
    expect(calls.generated).toEqual(['checkout', 'billing']); // both attempted
    expect(run.steps.filter((s) => s.kind === 'generate' && s.state === 'failed')).toHaveLength(2);
  });

  it('aborts the whole pass when the runner is not signed in', async () => {
    const r = report([feature('checkout', 0, { planCount: 1, planRefs: [planRef('p1')] })]);
    const { deps } = makeDeps([r, r], {
      runHunt: async () => ({ runId: 'r1', finalState: 'failed', reason: 'auth_required' }),
    });
    const id = startCoverageRun(repoId, {}, deps);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('failed');
    expect(run.errorMessage).toMatch(/signed in/i);
  });

  it('fails fast when no coding-agent CLI is installed', async () => {
    const { deps } = makeDeps([report([])], { runnerAvailable: async () => false });
    const id = startCoverageRun(repoId, {}, deps);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('failed');
    expect(run.errorMessage).toMatch(/CLI/i);
  });

  it('runs the LLM map scan when no coverage map exists', async () => {
    const { deps, calls } = makeDeps([
      report([], { hasCoverageMap: false }), // first build: no map
      report([feature('auth', 90)]), // after map: a covered feature, no gaps
      report([feature('auth', 90)]),
    ]);
    const id = startCoverageRun(repoId, {}, deps);
    const run = await waitForTerminal(id);
    expect(calls.maps).toBe(1);
    expect(run.stage).toBe('done');
  });

  it('single-flights per repo', () => {
    const { deps } = makeDeps([report([])]);
    const first = startCoverageRun(repoId, {}, deps);
    const second = startCoverageRun(repoId, {}, deps);
    expect(second).toBe(first);
  });

  it('records the findings count on a hunt step', async () => {
    const r = report([feature('checkout', 30, { planCount: 1, planRefs: [planRef('p1')] })]);
    // A real run row so the previews' run_id FK is satisfied (mirrors prod,
    // where the hunt's runId is a live run created by the orchestrator).
    const huntRun = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: null,
      trigger: 'manual',
      taskRef: 'plan:p1',
      taskContext: null,
      runnerUsed: 'claude',
    });
    insertPreview({ repoId, runId: huntRun.id, agentName: 'qa-hunter', payload: { title: 'a' } });
    insertPreview({ repoId, runId: huntRun.id, agentName: 'qa-hunter', payload: { title: 'b' } });
    const { deps } = makeDeps([r, r], {
      runHunt: async (input) => {
        input.onStarted?.({ runId: huntRun.id, taskRef: input.taskId ?? null, taskContext: null });
        return { runId: huntRun.id, finalState: 'done', reason: 'previewed' };
      },
    });
    const id = startCoverageRun(repoId, { checkpointInterval: Infinity }, deps);
    const run = await waitForTerminal(id);
    const hunt = run.steps.find((s) => s.kind === 'hunt');
    expect(hunt?.findings).toBe(2);
    expect(hunt?.runId).toBe(huntRun.id);
  });

  it('cancels immediately, aborting the live hunt', async () => {
    const r = report([feature('checkout', 30, { planCount: 1, planRefs: [planRef('p1')] })]);
    const { deps } = makeDeps([r, r], {
      // Mirror the real orchestrator: register the run + an AbortController,
      // resolve only when cancelRun() aborts it (i.e. the loop cancelled us).
      runHunt: async (input) => {
        const ctrl = registerRun('r1');
        input.onStarted?.({ runId: 'r1', taskRef: input.taskId ?? null, taskContext: null });
        await new Promise<void>((resolve) => {
          if (ctrl.signal.aborted) return resolve();
          ctrl.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { runId: 'r1', finalState: 'cancelled', reason: 'user_cancelled' };
      },
    });
    const id = startCoverageRun(repoId, { checkpointInterval: Infinity }, deps);
    await waitForStep(id, (s) => s.kind === 'hunt' && s.state === 'running');
    cancelCoverageRun(id);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('cancelled');
  });

  it('auto-pauses for review after the checkpoint interval, then resumes', async () => {
    // Four plans, pause after every 2 hunts. After 2 it should park at 'paused'.
    const r = report([
      feature('a', 10, { planCount: 1, planRefs: [planRef('pa')] }),
      feature('b', 20, { planCount: 1, planRefs: [planRef('pb')] }),
      feature('c', 30, { planCount: 1, planRefs: [planRef('pc')] }),
      feature('d', 40, { planCount: 1, planRefs: [planRef('pd')] }),
    ]);
    const { deps, calls } = makeDeps([r, r]);
    const id = startCoverageRun(repoId, { checkpointInterval: 2 }, deps);

    const paused = await waitForStage(id, 'paused');
    expect(paused.steps.filter((s) => s.kind === 'hunt' && s.state === 'done')).toHaveLength(2);
    // A paused run is still the repo's active single-flight pass.
    expect(getActiveCoverageRun(repoId)?.id).toBe(id);

    resumeCoverageRun(id);
    const done = await waitForTerminal(id);
    expect(done.stage).toBe('done');
    expect(calls.hunted).toHaveLength(4);
  });

  it('pauses on request after the in-flight hunt, then resumes', async () => {
    const r = report([
      feature('a', 10, { planCount: 1, planRefs: [planRef('pa')] }),
      feature('b', 20, { planCount: 1, planRefs: [planRef('pb')] }),
    ]);
    const hunted: string[] = [];
    let firstStarted!: () => void;
    const firstStartedP = new Promise<void>((res) => {
      firstStarted = res;
    });
    let releaseFirst!: () => void;
    const releaseFirstP = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const { deps } = makeDeps([r, r], {
      runHunt: async (input) => {
        const isFirst = hunted.length === 0;
        hunted.push(input.taskId ?? '');
        if (isFirst) {
          firstStarted();
          await releaseFirstP; // hold the first hunt in flight
        }
        return { runId: 'r1', finalState: 'done', reason: 'previewed' };
      },
    });
    const id = startCoverageRun(repoId, { checkpointInterval: Infinity }, deps);
    await firstStartedP;
    pauseCoverageRun(id); // request pause while the first hunt runs
    releaseFirst(); // it must be allowed to finish (no wasted work)
    const paused = await waitForStage(id, 'paused');
    // Pause took effect AFTER the first hunt and BEFORE the second.
    expect(hunted).toHaveLength(1);
    expect(paused.steps.filter((s) => s.kind === 'hunt' && s.state === 'done')).toHaveLength(1);

    resumeCoverageRun(id);
    const done = await waitForTerminal(id);
    expect(done.stage).toBe('done');
    expect(hunted).toHaveLength(2);
  });

  it('scheduled passes never auto-pause', async () => {
    const r = report([
      feature('a', 10, { planCount: 1, planRefs: [planRef('pa')] }),
      feature('b', 20, { planCount: 1, planRefs: [planRef('pb')] }),
      feature('c', 30, { planCount: 1, planRefs: [planRef('pc')] }),
    ]);
    const { deps, calls } = makeDeps([r, r]);
    const id = startCoverageRun(repoId, { trigger: 'schedule', checkpointInterval: 2 }, deps);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('done');
    expect(calls.hunted).toHaveLength(3);
  });

  it('cancels a paused pass', async () => {
    const r = report([
      feature('a', 10, { planCount: 1, planRefs: [planRef('pa')] }),
      feature('b', 20, { planCount: 1, planRefs: [planRef('pb')] }),
      feature('c', 30, { planCount: 1, planRefs: [planRef('pc')] }),
    ]);
    const { deps } = makeDeps([r, r]);
    const id = startCoverageRun(repoId, { checkpointInterval: 2 }, deps);
    await waitForStage(id, 'paused');
    cancelCoverageRun(id);
    const run = await waitForTerminal(id);
    expect(run.stage).toBe('cancelled');
  });
});

describe('buildHuntQueue', () => {
  it('orders worst-coverage features first, whole-app last', () => {
    const r = report(
      [
        feature('a', 80, { planRefs: [planRef('pa')] }),
        feature('b', 10, { planRefs: [planRef('pb')] }),
      ],
      { wholeAppPlans: [planRef('pw')] },
    );
    expect(buildHuntQueue(r).map((q) => q.planId)).toEqual(['pb', 'pa', 'pw']);
  });

  it('dedupes a plan shared across features', () => {
    const shared = planRef('shared');
    const r = report([
      feature('a', 10, { planRefs: [shared] }),
      feature('b', 20, { planRefs: [shared] }),
    ]);
    expect(buildHuntQueue(r).filter((q) => q.planId === 'shared')).toHaveLength(1);
  });
});
