import { ulid } from 'ulid';
import type { CoverageMapGenerationJob, CoverageMapGenerationStage } from '../../shared/types';
import { broadcast } from '../ipc/bus';

/**
 * In-memory tracker for `coverage:generateMap` jobs. Mirrors the test plan
 * job tracker so the renderer's toast/progress logic can reuse familiar
 * patterns. Lost on app restart; terminal jobs older than 30 min are
 * pruned.
 */
const TERMINAL_TTL_MS = 30 * 60 * 1000;

const jobs = new Map<string, CoverageMapGenerationJob>();

const STAGE_STATUS: Record<CoverageMapGenerationStage, string> = {
  queued: 'Queued — preparing to scan…',
  spawning: 'Starting Claude/Codex…',
  reading: 'Reading the codebase to identify features…',
  writing: 'Writing qa/coverage-map.md…',
  done: 'Coverage map ready.',
  failed: 'Generation failed.',
};

export function startJob(opts: { repoId: string }): CoverageMapGenerationJob {
  pruneStale();
  const jobId = `cmg-${ulid().slice(-12).toLowerCase()}`;
  const job: CoverageMapGenerationJob = {
    jobId,
    repoId: opts.repoId,
    stage: 'queued',
    status: STAGE_STATUS.queued,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    labelCount: null,
    addedLabels: null,
    errorMessage: null,
    errorHint: null,
  };
  jobs.set(jobId, job);
  broadcast({ type: 'coverageMapGeneration.progress', job: { ...job } });
  return { ...job };
}

export function advanceStage(
  jobId: string,
  stage: CoverageMapGenerationStage,
  status?: string,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = stage;
  job.status = status ?? STAGE_STATUS[stage];
  if (stage === 'done' || stage === 'failed') job.finishedAt = new Date().toISOString();
  broadcast({ type: 'coverageMapGeneration.progress', job: { ...job } });
}

export function finishDone(
  jobId: string,
  opts: { labelCount: number; addedLabels: string[] },
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = 'done';
  job.status = STAGE_STATUS.done;
  job.labelCount = opts.labelCount;
  job.addedLabels = opts.addedLabels;
  job.finishedAt = new Date().toISOString();
  broadcast({ type: 'coverageMapGeneration.progress', job: { ...job } });
}

export function finishFailed(jobId: string, errorMessage: string, errorHint?: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = 'failed';
  job.status = STAGE_STATUS.failed;
  job.errorMessage = errorMessage;
  job.errorHint = errorHint ?? null;
  job.finishedAt = new Date().toISOString();
  broadcast({ type: 'coverageMapGeneration.progress', job: { ...job } });
}

export function listJobs(repoId?: string): CoverageMapGenerationJob[] {
  pruneStale();
  const out: CoverageMapGenerationJob[] = [];
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

export function clearAllJobsForTesting(): void {
  jobs.clear();
}
