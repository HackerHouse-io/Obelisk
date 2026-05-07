import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import type { TestPlanGenerationJob, TestPlanGenerationStage } from '../../shared/types';

/**
 * Floating toast that surfaces in-flight test-plan generations and lets the
 * user click into the resulting plan when one finishes. Mounted at the app
 * shell so it survives route changes — generation runs in the background
 * and the user can keep using the app while it works.
 *
 * The toast subscribes to the bus and seeds itself from `testPlans:generationJobs`
 * on mount so a fresh navigation still sees in-flight work.
 */

const STAGE_PROGRESS: Record<TestPlanGenerationStage, number> = {
  queued: 0.05,
  spawning: 0.15,
  reading: 0.4,
  drafting: 0.7,
  writing: 0.92,
  done: 1,
  failed: 1,
};

export function TestPlanGenerationToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);

  const [jobs, setJobs] = useState<TestPlanGenerationJob[]>([]);

  useEffect(() => {
    void window.obelisk
      .invoke('testPlans:generationJobs', selectedRepoId ? { repoId: selectedRepoId } : {})
      .then((res) => {
        if (res.ok) setJobs(res.value);
      });
  }, [selectedRepoId]);

  useEffect(() => {
    return window.obelisk.subscribe((evt) => {
      if (evt.type !== 'testPlanGeneration.progress') return;
      // Filter to the active repo so a stale job from another repo doesn't
      // pop a toast in the wrong context.
      if (selectedRepoId && evt.job.repoId !== selectedRepoId) return;
      setJobs((prev) => upsertJob(prev, evt.job));
    });
  }, [selectedRepoId]);

  if (jobs.length === 0) return null;

  function dismiss(jobId: string): void {
    void window.obelisk.invoke('testPlans:dismissJob', { jobId }).then(() => {
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    });
  }

  function openPlan(planId: string): void {
    setRoute('test-plans');
    // Navigate first; the screen subscribes to testPlans.changed and will
    // pick up the new id when it remounts.
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('obelisk:open-test-plan', { detail: { planId } }));
    });
  }

  return (
    <div className="tpg-toast-stack" role="status" aria-live="polite">
      {jobs.map((job) => (
        <ToastCard
          key={job.jobId}
          job={job}
          repoLabel={repos.find((r) => r.id === job.repoId)?.githubFullName ?? job.repoId.slice(-6)}
          onDismiss={() => dismiss(job.jobId)}
          onOpen={() => job.planId && openPlan(job.planId)}
        />
      ))}
    </div>
  );
}

function ToastCard({
  job,
  repoLabel,
  onDismiss,
  onOpen,
}: {
  job: TestPlanGenerationJob;
  repoLabel: string;
  onDismiss: () => void;
  onOpen: () => void;
}): ReactElement {
  const isTerminal = job.stage === 'done' || job.stage === 'failed';
  const progress = STAGE_PROGRESS[job.stage];
  const tone = job.stage === 'failed' ? 'error' : job.stage === 'done' ? 'ok' : 'busy';

  const headline =
    job.stage === 'done'
      ? 'Test plan ready'
      : job.stage === 'failed'
        ? 'Generation failed'
        : 'Drafting test plan…';

  const sub =
    job.stage === 'done'
      ? `${repoLabel} · open and review`
      : job.stage === 'failed'
        ? (job.errorMessage ?? 'Something went wrong')
        : job.status;

  return (
    <div
      className={`tpg-toast tpg-toast-${tone}`}
      data-testid={`tpg-toast-${job.jobId}`}
      role="group"
    >
      <div className="tpg-toast-icon">
        {job.stage === 'failed' ? (
          <Icon.AlertTri size={14} />
        ) : job.stage === 'done' ? (
          <Icon.Check size={14} />
        ) : (
          <Icon.Spinner size={14} style={{ animation: 'spin 1s linear infinite' }} />
        )}
      </div>
      <div className="tpg-toast-body">
        <div className="tpg-toast-headline">{headline}</div>
        <div className="tpg-toast-sub">{sub}</div>
        {job.stage === 'failed' && job.errorHint ? (
          <div className="tpg-toast-hint">{job.errorHint}</div>
        ) : null}
        {!isTerminal ? (
          <div className="tpg-toast-progress">
            <div
              className="tpg-toast-progress-fill"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="tpg-toast-actions">
        {job.stage === 'done' ? (
          <button
            type="button"
            className="btn primary sm"
            onClick={onOpen}
            data-testid="tpg-toast-open"
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost icon"
          onClick={onDismiss}
          aria-label="Dismiss"
          disabled={!isTerminal}
          title={isTerminal ? 'Dismiss' : 'Generation in progress — cannot dismiss yet'}
        >
          <Icon.Close size={11} />
        </button>
      </div>
    </div>
  );
}

function upsertJob(
  prev: TestPlanGenerationJob[],
  next: TestPlanGenerationJob,
): TestPlanGenerationJob[] {
  const idx = prev.findIndex((j) => j.jobId === next.jobId);
  if (idx === -1) return [next, ...prev];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}
