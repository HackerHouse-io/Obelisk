import { ulid } from 'ulid';
import type {
  AgentName,
  TestPlanGenerationJob,
  TestPlanGenerationStage,
  TestPlanScope,
} from '../../shared/types';
import { broadcast } from '../ipc/bus';

/**
 * In-memory tracker of currently-running and recently-completed test plan
 * generation jobs. Lost on app restart — terminal jobs older than 30 min
 * are pruned so the toast doesn't accumulate stale entries.
 *
 * Renderer subscribes to 'testPlanGeneration.progress' bus events and uses
 * `testPlans:generationJobs` to seed the list on first mount.
 */
const TERMINAL_TTL_MS = 30 * 60 * 1000;

const jobs = new Map<string, TestPlanGenerationJob>();

const STAGE_STATUS: Record<TestPlanGenerationStage, string> = {
  queued: 'Queued — preparing to scan your repo…',
  spawning: 'Starting the runner…',
  reading: 'Reading codebase + identifying features…',
  drafting: 'Drafting per-feature test cases…',
  writing: 'Saving plan to your repo…',
  done: 'Plan ready.',
  failed: 'Generation failed.',
};

export function startJob(opts: {
  repoId: string;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName?: string;
}): TestPlanGenerationJob {
  pruneStale();
  const jobId = `tpg-${ulid().slice(-12).toLowerCase()}`;
  const job: TestPlanGenerationJob = {
    jobId,
    repoId: opts.repoId,
    agentName: opts.agentName,
    scope: opts.scope,
    feature: opts.featureName?.trim() ?? null,
    stage: 'queued',
    status: STAGE_STATUS.queued,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    planId: null,
    errorMessage: null,
    errorHint: null,
  };
  jobs.set(jobId, job);
  broadcast({ type: 'testPlanGeneration.progress', job: { ...job } });
  return { ...job };
}

export function advanceStage(jobId: string, stage: TestPlanGenerationStage, status?: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = stage;
  job.status = status ?? STAGE_STATUS[stage];
  if (stage === 'done' || stage === 'failed') job.finishedAt = new Date().toISOString();
  broadcast({ type: 'testPlanGeneration.progress', job: { ...job } });
}

export function finishDone(jobId: string, planId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = 'done';
  job.status = STAGE_STATUS.done;
  job.planId = planId;
  job.finishedAt = new Date().toISOString();
  broadcast({ type: 'testPlanGeneration.progress', job: { ...job } });
}

export function finishFailed(jobId: string, errorMessage: string, errorHint?: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = 'failed';
  job.status = STAGE_STATUS.failed;
  job.errorMessage = errorMessage;
  job.errorHint = errorHint ?? null;
  job.finishedAt = new Date().toISOString();
  broadcast({ type: 'testPlanGeneration.progress', job: { ...job } });
}

export function listJobs(repoId?: string): TestPlanGenerationJob[] {
  pruneStale();
  const out: TestPlanGenerationJob[] = [];
  for (const job of jobs.values()) {
    if (repoId && job.repoId !== repoId) continue;
    out.push({ ...job });
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

export function dismissJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  // Only terminal jobs are dismissable; the renderer enforces this too
  // but defending here keeps the in-flight job alive even if a stale UI
  // tries to dismiss it.
  if (job.stage !== 'done' && job.stage !== 'failed') return;
  jobs.delete(jobId);
}

function pruneStale(): void {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (job.stage !== 'done' && job.stage !== 'failed') continue;
    if (!job.finishedAt) continue;
    if (now - new Date(job.finishedAt).getTime() > TERMINAL_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

/** Test-only: clear the map between vitest runs. */
export function clearAllJobsForTesting(): void {
  jobs.clear();
}
