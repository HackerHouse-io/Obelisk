import { addInProcessListener } from '../ipc/bus';
import type { BusEvent } from '../../shared/types';

/**
 * The Coverage Agent loop sequences fire-and-forget jobs (test-plan
 * generation, coverage-map generation) that report terminal state on the
 * bus. These helpers turn "start a job, then watch the bus for its
 * done/failed event" into an awaitable — the same pattern `test-plans/
 * generate.ts:waitForJob` uses internally, factored out so the loop can
 * reuse it without depending on generation internals.
 *
 * Subscribe BEFORE the underlying job can emit: callers start the job
 * (which returns a jobId synchronously and runs async on a later tick),
 * then immediately await here, so the first progress event is never missed.
 *
 * A defensive timeout guarantees the loop can't hang forever if a terminal
 * event is somehow dropped — each underlying job already enforces its own
 * 8-minute spawn timeout, so this is a backstop, not the primary bound.
 */
const AWAIT_TIMEOUT_MS = 12 * 60 * 1000;

export interface JobOutcome {
  ok: boolean;
  planId?: string | null;
  errorMessage?: string | null;
  errorHint?: string | null;
}

function awaitJob(jobId: string, match: (evt: BusEvent) => JobOutcome | null): Promise<JobOutcome> {
  return new Promise<JobOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: JobOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = addInProcessListener((evt) => {
      const outcome = match(evt);
      if (outcome) finish(outcome);
    });
    const timer = setTimeout(() => {
      finish({
        ok: false,
        errorMessage: `Timed out waiting for job ${jobId} to finish.`,
        errorHint: 'The underlying runner may be stuck. Try the pass again.',
      });
    }, AWAIT_TIMEOUT_MS);
  });
}

export function awaitTestPlanJob(jobId: string): Promise<JobOutcome> {
  return awaitJob(jobId, (evt) => {
    if (evt.type !== 'testPlanGeneration.progress' || evt.job.jobId !== jobId) return null;
    if (evt.job.stage === 'done') return { ok: true, planId: evt.job.planId };
    if (evt.job.stage === 'failed') {
      return { ok: false, errorMessage: evt.job.errorMessage, errorHint: evt.job.errorHint };
    }
    return null;
  });
}

export function awaitCoverageMapJob(jobId: string): Promise<JobOutcome> {
  return awaitJob(jobId, (evt) => {
    if (evt.type !== 'coverageMapGeneration.progress' || evt.job.jobId !== jobId) return null;
    if (evt.job.stage === 'done') return { ok: true };
    if (evt.job.stage === 'failed') {
      return { ok: false, errorMessage: evt.job.errorMessage, errorHint: evt.job.errorHint };
    }
    return null;
  });
}
