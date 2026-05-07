import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  advanceStage,
  clearAllJobsForTesting,
  dismissJob,
  finishDone,
  finishFailed,
  listJobs,
  startJob,
} from '../../src/main/test-plans/jobs';
import { addInProcessListener } from '../../src/main/ipc/bus';
import type { BusEvent } from '../../src/shared/types';

let captured: BusEvent[];
let unsubscribe: (() => void) | null;

beforeEach(() => {
  clearAllJobsForTesting();
  captured = [];
  unsubscribe = addInProcessListener((evt) => captured.push(evt));
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe('test-plan generation job tracker', () => {
  it('startJob emits a queued bus event with the right shape', () => {
    const job = startJob({
      repoId: 'r1',
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    expect(job.stage).toBe('queued');
    expect(job.repoId).toBe('r1');
    expect(captured).toHaveLength(1);
    const evt = captured[0]!;
    expect(evt.type).toBe('testPlanGeneration.progress');
    if (evt.type === 'testPlanGeneration.progress') {
      expect(evt.job.jobId).toBe(job.jobId);
      expect(evt.job.stage).toBe('queued');
    }
  });

  it('advanceStage updates state and emits per-stage events', () => {
    const job = startJob({
      repoId: 'r1',
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    advanceStage(job.jobId, 'spawning');
    advanceStage(job.jobId, 'reading');
    advanceStage(job.jobId, 'drafting', 'Drafting: looking at src/main…');

    const stages = captured
      .filter((e) => e.type === 'testPlanGeneration.progress')
      .map((e) => (e.type === 'testPlanGeneration.progress' ? e.job.stage : null));
    expect(stages).toEqual(['queued', 'spawning', 'reading', 'drafting']);

    const last = listJobs('r1')[0]!;
    expect(last.stage).toBe('drafting');
    expect(last.status).toMatch(/Drafting/);
  });

  it('finishDone records planId and ends the job at done', () => {
    const job = startJob({
      repoId: 'r1',
      agentName: 'manual-qa',
      scope: 'feature',
      featureName: 'checkout',
    });
    finishDone(job.jobId, 'feature-checkout-manual-qa');

    const ended = listJobs('r1')[0]!;
    expect(ended.stage).toBe('done');
    expect(ended.planId).toBe('feature-checkout-manual-qa');
    expect(ended.finishedAt).not.toBeNull();
  });

  it('finishFailed records error message + hint', () => {
    const job = startJob({
      repoId: 'r1',
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    finishFailed(job.jobId, 'codex exited 1.', "Run 'codex --version' to verify.");

    const ended = listJobs('r1')[0]!;
    expect(ended.stage).toBe('failed');
    expect(ended.errorMessage).toBe('codex exited 1.');
    expect(ended.errorHint).toBe("Run 'codex --version' to verify.");
  });

  it('dismissJob only removes terminal jobs', () => {
    const inflight = startJob({
      repoId: 'r1',
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    dismissJob(inflight.jobId); // should be a no-op
    expect(listJobs('r1')).toHaveLength(1);

    finishDone(inflight.jobId, 'full-app');
    dismissJob(inflight.jobId);
    expect(listJobs('r1')).toHaveLength(0);
  });

  it('listJobs filters by repoId', () => {
    startJob({ repoId: 'r1', agentName: 'qa-hunter', scope: 'whole-app' });
    startJob({ repoId: 'r2', agentName: 'manual-qa', scope: 'whole-app' });
    expect(listJobs('r1')).toHaveLength(1);
    expect(listJobs('r2')).toHaveLength(1);
    expect(listJobs()).toHaveLength(2);
  });
});
