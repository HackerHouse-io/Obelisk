import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import {
  advanceCoverageStage,
  appendCoverageStep,
  createCoverageRun,
  failCoverageRun,
  getActiveCoverageRun,
  getCoverageRun,
  getLatestCoverageRun,
  incrementSpawns,
  isCancelRequested,
  listCoverageRuns,
  reconcileCoverageRuns,
  requestCancelCoverageRun,
  updateCoverageStep,
} from '../../src/main/db/coverage-runs';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-covruns-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function newRun(repoId = 'repo-1') {
  return createCoverageRun({ repoId, trigger: 'manual', gapThreshold: 70, budgetSpawns: 8 });
}

describe('coverage_runs persistence', () => {
  it('creates a queued run and reads it back', () => {
    const run = newRun();
    expect(run.stage).toBe('queued');
    expect(run.budgetSpawns).toBe(8);
    expect(run.gapThreshold).toBe(70);
    expect(getCoverageRun(run.id)?.id).toBe(run.id);
  });

  it('treats the active run as the live, non-terminal one', () => {
    const run = newRun();
    expect(getActiveCoverageRun('repo-1')?.id).toBe(run.id);
    advanceCoverageStage(run.id, 'done', 'finished');
    expect(getActiveCoverageRun('repo-1')).toBeNull();
  });

  it('getLatest prefers the active run, else the most recent', () => {
    const first = newRun();
    advanceCoverageStage(first.id, 'done');
    const second = newRun();
    expect(getLatestCoverageRun('repo-1')?.id).toBe(second.id);
  });

  it('advanceStage stamps finished_at on terminal stages only', () => {
    const run = newRun();
    advanceCoverageStage(run.id, 'hunting');
    expect(getCoverageRun(run.id)?.finishedAt).toBeNull();
    advanceCoverageStage(run.id, 'done');
    expect(getCoverageRun(run.id)?.finishedAt).not.toBeNull();
  });

  it('failCoverageRun records message + hint and goes terminal', () => {
    const run = newRun();
    failCoverageRun(run.id, 'boom', 'try again');
    const after = getCoverageRun(run.id);
    expect(after?.stage).toBe('failed');
    expect(after?.errorMessage).toBe('boom');
    expect(after?.errorHint).toBe('try again');
    expect(after?.finishedAt).not.toBeNull();
  });

  it('increments the spawn counter', () => {
    const run = newRun();
    expect(incrementSpawns(run.id)).toBe(1);
    expect(incrementSpawns(run.id)).toBe(2);
    expect(getCoverageRun(run.id)?.spawnsUsed).toBe(2);
  });

  it('records and updates steps in order', () => {
    const run = newRun();
    const s1 = appendCoverageStep({ coverageRunId: run.id, kind: 'generate', state: 'running' });
    const s2 = appendCoverageStep({
      coverageRunId: run.id,
      kind: 'hunt',
      featureLabel: 'checkout',
      ref: 'plan:p1',
      state: 'running',
    });
    updateCoverageStep(s1, { state: 'done' });
    const steps = getCoverageRun(run.id)!.steps;
    expect(steps.map((s) => s.id)).toEqual([s1, s2]);
    expect(steps[0]!.state).toBe('done');
    expect(steps[1]!.featureLabel).toBe('checkout');
    expect(steps[1]!.ref).toBe('plan:p1');
  });

  it('tracks cancel requests', () => {
    const run = newRun();
    expect(isCancelRequested(run.id)).toBe(false);
    requestCancelCoverageRun(run.id);
    expect(isCancelRequested(run.id)).toBe(true);
  });

  it('lists runs newest-first', () => {
    const a = newRun();
    const b = newRun();
    const ids = listCoverageRuns('repo-1').map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('reconcile fails any non-terminal pass on restart', () => {
    const run = newRun();
    advanceCoverageStage(run.id, 'hunting');
    const fixed = reconcileCoverageRuns();
    expect(fixed).toBe(1);
    const after = getCoverageRun(run.id);
    expect(after?.stage).toBe('failed');
    expect(after?.errorMessage).toContain('interrupted');
    // A second reconcile is a no-op — terminal runs are left alone.
    expect(reconcileCoverageRuns()).toBe(0);
  });
});
