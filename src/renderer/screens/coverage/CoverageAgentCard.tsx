import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { showApiAlert } from '../../state/alert-store';
import { isCoverageRunTerminal } from '../../../shared/coverage-formula';
import type {
  BusEvent,
  CoverageRunStage,
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

/** Visual state of one phase chip given the run and the current phase index. */
function phaseState(
  run: CoverageRunSummary | null,
  currentIdx: number,
  phaseIdx: number,
): 'done' | 'active' | 'idle' {
  if (run && isCoverageRunTerminal(run.stage)) return run.stage === 'done' ? 'done' : 'idle';
  if (currentIdx < 0) return 'idle';
  if (phaseIdx < currentIdx) return 'done';
  if (phaseIdx === currentIdx) return 'active';
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

  async function patchSchedule(patch: { enabled?: boolean; cron?: string }): Promise<void> {
    const res = await window.obelisk.invoke('coverage:setSchedule', { repoId, ...patch });
    if (!res.ok) showApiAlert(res.error, 'update coverage schedule');
    else setSchedule(res.value);
  }

  const active = isActive(run);
  const currentIdx = run ? PHASES.findIndex((p) => p.stage === run.stage) : -1;
  const canRun = preflight ? preflight.canRun : true;
  const runDisabled = busy || active || !canRun;

  return (
    <div className="coverage-agent-card" data-testid="coverage-agent-card">
      <div className="coverage-agent-head">
        <div className="coverage-agent-title">
          <span className={`coverage-agent-dot${active ? ' running' : ''}`} aria-hidden="true" />
          Coverage Agent
        </div>
        <div className="coverage-agent-head-actions">
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
          {run.spawnsUsed > 0 ? (
            <span className="coverage-agent-status-budget">
              {run.spawnsUsed}/{run.budgetSpawns} spawns
            </span>
          ) : null}
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
    case 'done':
      return 'Pass complete.';
    case 'failed':
      return 'Pass failed.';
    case 'cancelled':
      return 'Pass cancelled.';
  }
}
