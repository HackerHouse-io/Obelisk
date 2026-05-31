import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { useStore } from '../../state/store';
import { showApiAlert } from '../../state/alert-store';
import { isCoverageRunResumable, isCoverageRunTerminal } from '../../../shared/coverage-formula';
import type {
  BusEvent,
  CoverageRunStage,
  CoverageRunStep,
  CoverageRunSummary,
  CoverageSchedule,
} from '../../../shared/types';

/** The four working stages, in order, for the phase strip. */
const PHASES: { stage: CoverageRunStage; label: string }[] = [
  { stage: 'mapping', label: 'Map' },
  { stage: 'detecting', label: 'Gaps' },
  { stage: 'drafting', label: 'Draft plans' },
  { stage: 'hunting', label: 'Hunt' },
];

function isActive(run: CoverageRunSummary | null): boolean {
  return run !== null && !isCoverageRunTerminal(run.stage);
}

/**
 * The working stage to highlight in the phase strip. While `paused` the run's
 * stage is `'paused'` (no phase), so infer the phase the pass was working from
 * its steps: a hunt step → Hunt, a generate step → Draft, a map step → Map.
 */
function effectiveStage(run: CoverageRunSummary): CoverageRunStage {
  if (run.stage !== 'paused') return run.stage;
  const kinds = new Set(run.steps.map((s) => s.kind));
  if (kinds.has('hunt')) return 'hunting';
  if (kinds.has('generate')) return 'drafting';
  if (kinds.has('map')) return 'mapping';
  return 'hunting';
}

/** Visual state of one phase chip given the run and the current phase index. */
function phaseState(
  run: CoverageRunSummary | null,
  currentIdx: number,
  phaseIdx: number,
): 'done' | 'active' | 'paused' | 'idle' {
  if (run && isCoverageRunTerminal(run.stage)) return run.stage === 'done' ? 'done' : 'idle';
  if (currentIdx < 0) return 'idle';
  if (phaseIdx < currentIdx) return 'done';
  if (phaseIdx === currentIdx) return run && run.stage === 'paused' ? 'paused' : 'active';
  return 'idle';
}

/** Schedule presets, mirroring the spirit of the per-agent cron picker. */
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Daily', cron: '0 3 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Weekly', cron: '0 3 * * 1' },
];

interface Props {
  repoId: string;
  /** Called when a pass finishes so the parent can refresh the coverage report. */
  onPassComplete: () => void;
}

/**
 * The Coverage Agent control surface. Shows the autonomous loop's live phase,
 * a Run/Cancel control (disabled by backend pre-flight ground truth), and the
 * per-repo schedule. Self-contained: hydrates its own status / preflight /
 * schedule and follows the `coverageRun.progress` bus event.
 */
export function CoverageAgentCard({ repoId, onPassComplete }: Props): ReactElement {
  const setRoute = useStore((s) => s.setRoute);
  const [run, setRun] = useState<CoverageRunSummary | null>(null);
  const [preflight, setPreflight] = useState<{ canRun: boolean; reason?: string } | null>(null);
  const [schedule, setSchedule] = useState<CoverageSchedule | null>(null);
  const [busy, setBusy] = useState(false);

  const hydrate = useCallback(async (): Promise<void> => {
    const [status, pre, sched] = await Promise.all([
      window.obelisk.invoke('coverage:loopStatus', { repoId }),
      window.obelisk.invoke('coverage:loopPreflight', { repoId }),
      window.obelisk.invoke('coverage:getSchedule', { repoId }),
    ]);
    if (status.ok) setRun(status.value);
    if (pre.ok) setPreflight(pre.value);
    if (sched.ok) setSchedule(sched.value);
  }, [repoId]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Follow the loop on the bus. When a pass reaches a terminal stage, ask the
  // parent to refresh the coverage report (gaps just changed).
  useEffect(() => {
    return window.obelisk.subscribe((event: BusEvent) => {
      if (event.type !== 'coverageRun.progress') return;
      if (event.run.repoId !== repoId) return;
      setRun(event.run);
      if (isCoverageRunTerminal(event.run.stage)) onPassComplete();
    });
  }, [repoId, onPassComplete]);

  async function startPass(): Promise<void> {
    if (busy || isActive(run)) return;
    setBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:startLoop', { repoId });
      if (!res.ok) showApiAlert(res.error, 'start coverage pass');
      else await hydrate();
    } finally {
      setBusy(false);
    }
  }

  async function cancelPass(): Promise<void> {
    if (!run || !isActive(run)) return;
    setBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:cancelLoop', { coverageRunId: run.id });
      if (!res.ok) showApiAlert(res.error, 'cancel coverage pass');
    } finally {
      setBusy(false);
    }
  }

  async function pausePass(): Promise<void> {
    if (!run || !isActive(run) || run.stage === 'paused') return;
    setBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:pauseLoop', { coverageRunId: run.id });
      if (!res.ok) showApiAlert(res.error, 'pause coverage pass');
    } finally {
      setBusy(false);
    }
  }

  async function resumePass(): Promise<void> {
    if (!run || !isCoverageRunResumable(run.stage)) return;
    setBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:resumeLoop', { coverageRunId: run.id });
      if (!res.ok) showApiAlert(res.error, 'resume coverage pass');
    } finally {
      setBusy(false);
    }
  }

  /** Jump to Mission Control and focus a spawned hunt run. */
  function openRun(runId: string): void {
    setRoute('mission');
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('obelisk:focus-run', { detail: { runId } }));
    });
  }

  async function patchSchedule(patch: { enabled?: boolean; cron?: string }): Promise<void> {
    const res = await window.obelisk.invoke('coverage:setSchedule', { repoId, ...patch });
    if (!res.ok) showApiAlert(res.error, 'update coverage schedule');
    else setSchedule(res.value);
  }

  const active = isActive(run);
  const paused = run ? isCoverageRunResumable(run.stage) : false;
  const currentIdx = run ? PHASES.findIndex((p) => p.stage === effectiveStage(run)) : -1;
  const canRun = preflight ? preflight.canRun : true;
  const runDisabled = busy || active || !canRun;
  const totalFindings = run ? run.steps.reduce((n, s) => n + (s.findings ?? 0), 0) : 0;
  const runningStep = run ? (run.steps.find((s) => s.state === 'running') ?? null) : null;

  return (
    <div className="coverage-agent-card" data-testid="coverage-agent-card">
      <div className="coverage-agent-head">
        <div className="coverage-agent-title">
          <span
            className={`coverage-agent-dot${active && !paused ? ' running' : ''}${paused ? ' paused' : ''}`}
            aria-hidden="true"
          />
          Coverage Agent
        </div>
        <div className="coverage-agent-head-actions">
          {paused ? (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void resumePass()}
              disabled={busy}
              data-testid="coverage-agent-resume"
            >
              <Icon.Play size={11} /> Resume
            </button>
          ) : active ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => void pausePass()}
              disabled={busy}
              title="Pause after the current step finishes"
              data-testid="coverage-agent-pause"
            >
              <Icon.Pause size={11} /> Pause
            </button>
          ) : (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void startPass()}
              disabled={runDisabled}
              title={canRun ? 'Map gaps, auto-draft plans, run the Bug Hunter' : preflight?.reason}
              data-testid="coverage-agent-run"
            >
              {busy ? (
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Play size={11} />
              )}{' '}
              Run coverage pass
            </button>
          )}
          {active ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => void cancelPass()}
              disabled={busy}
              data-testid="coverage-agent-cancel"
            >
              Stop
            </button>
          ) : null}
        </div>
      </div>

      <div className="coverage-agent-sub">
        Scans the repo, auto-drafts test plans where coverage is thin, and runs the Bug Hunter — no
        manual setup.
      </div>

      <div className="coverage-agent-phases" data-testid="coverage-agent-phases">
        {PHASES.map((p, i) => (
          <div
            key={p.stage}
            className={`coverage-agent-phase coverage-agent-phase-${phaseState(run, currentIdx, i)}`}
          >
            <span className="coverage-agent-phase-label">{p.label}</span>
          </div>
        ))}
      </div>

      {run ? (
        <div className="coverage-agent-status" data-testid="coverage-agent-status">
          <span className="coverage-agent-status-text">
            {run.status ?? stageFallback(run.stage)}
          </span>
          <span className="coverage-agent-status-meta">
            {totalFindings > 0 ? (
              <span className="coverage-agent-status-findings">
                {totalFindings} issue{totalFindings === 1 ? '' : 's'} found
              </span>
            ) : null}
            {run.spawnsUsed > 0 ? (
              <span className="coverage-agent-status-budget">
                {run.spawnsUsed}/{run.budgetSpawns} spawns
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* Now-running hint: what's happening this very moment. */}
      {runningStep ? (
        <div className="coverage-agent-now" data-testid="coverage-agent-now">
          <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
          {stepNowLabel(runningStep)}
        </div>
      ) : null}

      {/* Paused-for-review banner. */}
      {paused ? (
        <div className="coverage-agent-paused" data-testid="coverage-agent-paused">
          <Icon.Pause size={11} />
          <div>{run?.status ?? 'Paused for review.'}</div>
        </div>
      ) : null}

      {/* The live timeline: what already happened, step by step. */}
      {run && run.steps.length > 0 ? (
        <div className="coverage-agent-timeline" data-testid="coverage-agent-timeline">
          {run.steps.map((s) => (
            <CoverageStepRow key={s.id} step={s} onOpenRun={openRun} />
          ))}
        </div>
      ) : null}

      {run && run.stage === 'failed' && run.errorMessage ? (
        <div className="coverage-agent-error" data-testid="coverage-agent-error">
          <Icon.AlertTri size={11} /> {run.errorMessage}
          {run.errorHint ? <div className="coverage-agent-error-hint">{run.errorHint}</div> : null}
        </div>
      ) : null}

      {!canRun && preflight?.reason ? (
        <div className="coverage-agent-preflight">{preflight.reason}</div>
      ) : null}

      <div className="coverage-agent-schedule" data-testid="coverage-agent-schedule">
        <label className="coverage-agent-schedule-toggle">
          <input
            type="checkbox"
            checked={schedule?.enabled ?? false}
            onChange={(e) => void patchSchedule({ enabled: e.target.checked })}
            data-testid="coverage-agent-schedule-enabled"
          />
          Run on a schedule
        </label>
        <select
          className="file-issue-input coverage-agent-schedule-cron"
          value={schedule?.cron ?? CRON_PRESETS[0]!.cron}
          disabled={!(schedule?.enabled ?? false)}
          onChange={(e) => void patchSchedule({ cron: e.target.value })}
          data-testid="coverage-agent-schedule-cron"
        >
          {CRON_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
          {schedule && !CRON_PRESETS.some((p) => p.cron === schedule.cron) ? (
            <option value={schedule.cron}>{schedule.cron}</option>
          ) : null}
        </select>
      </div>
    </div>
  );
}

function stageFallback(stage: CoverageRunStage): string {
  switch (stage) {
    case 'queued':
      return 'Queued…';
    case 'mapping':
      return 'Mapping features…';
    case 'detecting':
      return 'Detecting gaps…';
    case 'drafting':
      return 'Drafting plans…';
    case 'hunting':
      return 'Running the Bug Hunter…';
    case 'paused':
      return 'Paused for review.';
    case 'done':
      return 'Pass complete.';
    case 'failed':
      return 'Pass failed.';
    case 'cancelled':
      return 'Pass cancelled.';
  }
}

/** Headline for the "happening right now" hint above the timeline. */
function stepNowLabel(step: CoverageRunStep): string {
  switch (step.kind) {
    case 'map':
      return 'Mapping the repository…';
    case 'generate':
      return `Drafting a test plan for ${step.featureLabel ?? 'a feature'}…`;
    case 'hunt':
      return `Hunting bugs in ${step.featureLabel ?? 'a plan'}…`;
  }
}

/** Past-tense label for a finished/queued timeline row. */
function stepLabel(step: CoverageRunStep): string {
  const running = step.state === 'running';
  switch (step.kind) {
    case 'map':
      return running ? 'Mapping the repository' : 'Mapped the repository';
    case 'generate':
      return `${running ? 'Drafting' : 'Drafted'} plan · ${step.featureLabel ?? 'feature'}`;
    case 'hunt':
      return `${running ? 'Hunting' : 'Hunted'} · ${step.featureLabel ?? 'plan'}`;
  }
}

function CoverageStepRow({
  step,
  onOpenRun,
}: {
  step: CoverageRunStep;
  onOpenRun: (runId: string) => void;
}): ReactElement {
  const clickable = step.kind === 'hunt' && !!step.runId;
  const body = (
    <>
      <span className={`coverage-agent-step-icon coverage-agent-step-icon-${step.state}`}>
        {step.state === 'running' ? (
          <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
        ) : step.state === 'done' ? (
          <Icon.Check size={11} />
        ) : step.state === 'failed' ? (
          <Icon.AlertTri size={11} />
        ) : (
          <Icon.Dot size={11} />
        )}
      </span>
      <span className="coverage-agent-step-label">{stepLabel(step)}</span>
      {step.kind === 'hunt' && step.findings != null ? (
        <span className={`coverage-agent-step-findings${step.findings > 0 ? ' has-findings' : ''}`}>
          {step.findings > 0 ? (
            <>
              <Icon.Bug size={10} /> {step.findings} issue{step.findings === 1 ? '' : 's'}
            </>
          ) : (
            'no issues'
          )}
        </span>
      ) : null}
      {step.state === 'skipped' ? <span className="coverage-agent-step-tag">skipped</span> : null}
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        className={`coverage-agent-step coverage-agent-step-${step.state} is-clickable`}
        onClick={() => onOpenRun(step.runId!)}
        title="Open this run in Mission Control"
      >
        {body}
      </button>
    );
  }
  return <div className={`coverage-agent-step coverage-agent-step-${step.state}`}>{body}</div>;
}
