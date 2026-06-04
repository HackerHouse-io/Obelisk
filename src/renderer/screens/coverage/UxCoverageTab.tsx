import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { showApiAlert, showAlert } from '../../state/alert-store';
import { runAgentByName } from '../../state/agent-actions';
import { useStore } from '../../state/store';
import { shortDate } from '../../format';
import { findActiveRun, type ActiveRun, type RunnerInstalled } from './FeatureCard';
import { UxCoverageRadar } from './UxCoverageRadar';
import type { BusEvent, TestPlanRef, UxCoverageReport, UxSurface } from '../../../shared/types';

interface Props {
  repoId: string;
  /** Jump to the Test Plans editor (for the "no map / no plans" path). */
  onOpenPlans: () => void;
}

/**
 * The "UX Coverage" tab on the Coverage screen. Read-out of what the UI/UX
 * Expert has swept, per surface (from the shared coverage map). Unlike test
 * coverage, "covered" here means *swept by the UI/UX Expert with no open UX
 * debt* — so each UI/UX Expert run updates this picture.
 *
 * The single "Run UX coverage pass" button is the intelligent entry point: it
 * ensures a whole-app UX plan exists (drafting one if needed) and runs the
 * UI/UX Expert against it, sweeping every surface in one pass. Clicking it
 * again re-sweeps; the per-surface Run buttons target one surface at a time.
 */
export function UxCoverageTab({ repoId, onOpenPlans }: Props): ReactElement {
  const [report, setReport] = useState<UxCoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<RunnerInstalled | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /** True while a whole-app UX plan is being drafted before the pass runs. */
  const [drafting, setDrafting] = useState(false);
  /** Set when the user clicked the pass button and we're waiting on plan generation. */
  const pendingPass = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const res = await window.obelisk.invoke('coverage:listUx', { repoId });
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setReport(res.value);
  }, [repoId]);

  const refreshActiveRuns = useCallback(async (): Promise<void> => {
    const res = await window.obelisk.invoke('runs:activeForRepo', { repoId });
    if (res.ok) setActiveRuns(res.value);
  }, [repoId]);

  useEffect(() => {
    void load();
    void refreshActiveRuns();
    void window.obelisk.invoke('runners:installed', {}).then((res) => {
      if (res.ok) setInstalled(res.value);
    });
  }, [load, refreshActiveRuns]);

  // Run the UI/UX Expert against the whole-app plan once it has been drafted.
  const runWholeApp = useCallback(
    async (planId: string): Promise<void> => {
      const res = await runAgentByName(repoId, 'ux-expert', { taskId: `plan:${planId}` });
      if (!res.ok) showApiAlert(res.error, 'run UI/UX Expert');
      else {
        void refreshActiveRuns();
        void load();
      }
    },
    [repoId, refreshActiveRuns, load],
  );

  // Live refresh: a finished run advances lastSweptAt; a preview/plan change
  // updates findings + plan rows. Also picks up the just-drafted whole-app plan
  // so the queued pass can fire. Mirrors Coverage.tsx's hooks.
  useEffect(() => {
    return window.obelisk.subscribe((event: BusEvent) => {
      if (event.type === 'run.created' || event.type === 'run.transition') {
        void refreshActiveRuns();
      }
      if (event.type === 'run.transition' && (event.state === 'done' || event.state === 'failed')) {
        void load();
      } else if (event.type === 'previews.changed' && event.repoId === repoId) {
        void load();
      } else if (event.type === 'testPlans.changed' && event.repoId === repoId) {
        void load();
      } else if (
        event.type === 'testPlanGeneration.progress' &&
        event.job.repoId === repoId &&
        event.job.agentName === 'ux-expert' &&
        event.job.scope === 'whole-app'
      ) {
        const job = event.job;
        if (job.stage === 'done' && job.planId && pendingPass.current) {
          pendingPass.current = false;
          setDrafting(false);
          void runWholeApp(job.planId);
        } else if (job.stage === 'failed' && pendingPass.current) {
          pendingPass.current = false;
          setDrafting(false);
          showAlert({
            title: 'Could not draft the UX plan',
            body: job.errorMessage + (job.errorHint ? `\n\n${job.errorHint}` : ''),
          });
        }
      }
    });
  }, [repoId, load, refreshActiveRuns, runWholeApp]);

  const setRoute = useStore((s) => s.setRoute);
  const runnersOk = installed ? installed.claude.installed || installed.codex.installed : null;
  const runnersHint =
    installed && !runnersOk
      ? (installed.claude.hint ?? installed.codex.hint ?? 'No coding-agent CLI on PATH.')
      : null;
  const activeUxRun = activeRuns.find((r) => r.agentName === 'ux-expert') ?? null;
  const sweeping = activeUxRun !== null;

  /** Jump to Mission Control and focus the in-flight sweep run. */
  function openRun(runId: string): void {
    setRoute('mission');
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('obelisk:focus-run', { detail: { runId } }));
    });
  }

  /** Stop the in-flight sweep — frees the button when a run is slow or wedged. */
  async function stopRun(runId: string): Promise<void> {
    const res = await window.obelisk.invoke('agents:cancel', { runId });
    if (!res.ok) showApiAlert(res.error, 'stop UX sweep');
    else void refreshActiveRuns();
  }

  /** The intelligent one-click pass: ensure a whole-app UX plan, then sweep. */
  async function runCoveragePass(): Promise<void> {
    if (!report || sweeping || drafting) return;
    const wholeApp = report.wholeAppPlans[0];
    if (wholeApp) {
      await runWholeApp(wholeApp.id);
      return;
    }
    // No whole-app UX plan yet — draft one, then the bus handler fires the run.
    setDrafting(true);
    pendingPass.current = true;
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId,
      agentName: 'ux-expert',
      scope: 'whole-app',
      focusOnChangedOrUncovered: false,
    });
    if (!res.ok) {
      pendingPass.current = false;
      setDrafting(false);
      showApiAlert(res.error, 'draft UX plan');
    }
  }

  if (report && !report.hasCoverageMap) {
    return (
      <div className="coverage-banner coverage-banner-info">
        <Icon.Sparkles size={12} />
        <div>
          No <span className="mono">qa/coverage-map.md</span> yet. Generate the coverage map on the{' '}
          <strong>Test Coverage</strong> tab — the UI/UX Expert audits the same surfaces.
        </div>
      </div>
    );
  }

  const surfaces = report?.surfaces ?? [];
  const passDisabled = installed === null || !runnersOk || sweeping || drafting;
  const passLabel = sweeping
    ? 'Sweeping the app…'
    : drafting
      ? 'Drafting full-app UX plan…'
      : 'Run UX coverage pass';
  const passBusy = sweeping || drafting;

  return (
    <div className="ux-coverage" data-testid="ux-coverage-tab">
      {report ? (
        <div className="coverage-radar-section">
          <div className="coverage-radar-stage">
            <UxCoverageRadar surfaces={surfaces} selectedLabel={selected} onSelect={setSelected} />
          </div>
          <div className="coverage-radar-summary">
            <button
              type="button"
              className="btn primary ux-coverage-pass-btn"
              disabled={passDisabled}
              onClick={() => void runCoveragePass()}
              title={
                runnersHint ??
                'Drafts a whole-app UX plan if needed, then sweeps every surface in one intelligent pass.'
              }
              data-testid="ux-coverage-pass-btn"
            >
              {passBusy ? (
                <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Spark size={12} />
              )}{' '}
              {passLabel}
            </button>
            {activeUxRun ? (
              <div className="ux-coverage-pass-controls">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => openRun(activeUxRun.runId)}
                  data-testid="ux-coverage-view-run"
                >
                  <Icon.Search size={11} /> View in Mission Control
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => void stopRun(activeUxRun.runId)}
                  data-testid="ux-coverage-stop-run"
                >
                  <Icon.Close size={11} /> Stop
                </button>
              </div>
            ) : null}
            <div className="ux-coverage-pass-hint">
              Sweeps every surface in one pass and keeps the radar fresh. Runs on a daily schedule
              too — configure it on the Agents screen. A full sweep drives every screen through
              Playwright, so it can take several minutes.
            </div>
            <div className="coverage-summary-stat">
              <div className="coverage-summary-stat-value">
                {report.sweptSurfaces}/{report.totalSurfaces}
              </div>
              <div className="coverage-summary-stat-label">surfaces swept</div>
            </div>
            <div className="coverage-summary-stat">
              <div
                className={`coverage-summary-stat-value${attentionCount(surfaces) > 0 ? ' warn' : ''}`}
              >
                {attentionCount(surfaces)}
              </div>
              <div className="coverage-summary-stat-label">need attention</div>
            </div>
            <div className="coverage-summary-stat">
              <div className="coverage-summary-stat-value">{openDebt(surfaces)}</div>
              <div className="coverage-summary-stat-label">open UX findings</div>
            </div>
            <div className="coverage-summary-stat">
              <div className="coverage-summary-stat-value text">
                {report.lastSweptAt ? shortDate(report.lastSweptAt) : '—'}
              </div>
              <div className="coverage-summary-stat-label">last UX sweep</div>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="coverage-banner coverage-banner-error">
          <Icon.AlertTri size={12} />
          <div>{error}</div>
        </div>
      ) : null}

      {surfaces.length > 0 ? (
        <div className="coverage-feature-grid">
          {surfaces.map((s) => (
            <UxSurfaceCard
              key={s.label}
              repoId={repoId}
              surface={s}
              installed={installed}
              activeRuns={activeRuns}
              runnersOk={runnersOk}
              runnersHint={runnersHint}
              selected={selected === s.label}
              onSelect={() => setSelected((cur) => (cur === s.label ? null : s.label))}
              onOpenPlans={onOpenPlans}
              onChange={() => {
                void load();
                void refreshActiveRuns();
              }}
            />
          ))}
        </div>
      ) : loading ? (
        <div className="coverage-empty">
          <Icon.Spinner size={14} style={{ animation: 'spin 0.9s linear infinite' }} /> Building UX
          coverage…
        </div>
      ) : report ? (
        <div className="coverage-empty">No surfaces in the coverage map yet.</div>
      ) : null}
    </div>
  );
}

function UxSurfaceCard({
  repoId,
  surface,
  installed,
  activeRuns,
  runnersOk,
  runnersHint,
  selected,
  onSelect,
  onOpenPlans,
  onChange,
}: {
  repoId: string;
  surface: UxSurface;
  installed: RunnerInstalled | null;
  activeRuns: ActiveRun[];
  runnersOk: boolean | null;
  runnersHint: string | null;
  selected: boolean;
  onSelect: () => void;
  onOpenPlans: () => void;
  onChange: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const hasPlan = surface.planRefs.length > 0;

  async function handleGenerate(): Promise<void> {
    setBusy(true);
    try {
      const res = await window.obelisk.invoke('testPlans:generate', {
        repoId,
        agentName: 'ux-expert',
        scope: 'feature',
        featureName: surface.label,
        focusOnChangedOrUncovered: false,
      });
      if (!res.ok) showApiAlert(res.error, 'generate UX plan');
      else onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`coverage-feature-card ux-surface-card ux-surface-card-${surface.uxHealth}${
        selected ? ' selected' : ''
      }`}
    >
      <button
        type="button"
        className="coverage-feature-card-head ux-surface-card-head"
        onClick={onSelect}
      >
        <div className="coverage-feature-card-label">{surface.label}</div>
        <UxHealthPill surface={surface} />
      </button>

      <div className="coverage-feature-card-stats">
        <Stat
          label="Last swept"
          value={surface.lastSweptAt ? shortDate(surface.lastSweptAt) : 'never'}
        />
        <Stat
          label="Findings"
          value={String(surface.openFindings)}
          tone={surface.openFindings > 0 ? 'bad' : undefined}
        />
        <Stat label="Severity" value={severitySummary(surface)} />
      </div>

      <div className="coverage-feature-card-actions">
        {hasPlan ? (
          <div className="coverage-feature-card-runs">
            {surface.planRefs.map((plan) => (
              <RunUxButton
                key={plan.id}
                repoId={repoId}
                plan={plan}
                activeRuns={activeRuns}
                runnersOk={runnersOk}
                runnersHint={runnersHint}
                installed={installed}
                label={`Run UI/UX Expert · ${plan.name}`}
                onRan={onChange}
              />
            ))}
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || installed === null || !runnersOk}
              onClick={() => void handleGenerate()}
              title={runnersHint ?? `Generate a UX surface plan for ${surface.label}`}
              data-testid={`ux-surface-generate-${surface.label}`}
            >
              {busy ? (
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Sparkles size={11} />
              )}{' '}
              Generate UX plan
            </button>
            <button type="button" className="btn sm" onClick={onOpenPlans} title="Open Test Plans">
              <Icon.Doc size={11} /> Plans
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RunUxButton({
  repoId,
  plan,
  activeRuns,
  runnersOk,
  runnersHint,
  installed,
  label,
  onRan,
}: {
  repoId: string;
  plan: TestPlanRef;
  activeRuns: ActiveRun[];
  runnersOk: boolean | null;
  runnersHint: string | null;
  installed: RunnerInstalled | null;
  label: string;
  onRan: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const activeRun = findActiveRun(activeRuns, plan.id, 'ux-expert');
  const running = activeRun !== null;
  const disabled = busy || running || installed === null || !runnersOk;

  async function handleRun(): Promise<void> {
    setBusy(true);
    try {
      const res = await runAgentByName(repoId, 'ux-expert', { taskId: `plan:${plan.id}` });
      if (!res.ok) showApiAlert(res.error, 'run UI/UX Expert');
      else onRan();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn sm ux-run-btn"
      disabled={disabled}
      onClick={() => void handleRun()}
      title={
        running
          ? `UI/UX Expert is already running on "${plan.name}"`
          : (runnersHint ?? `Run the UI/UX Expert against "${plan.name}"`)
      }
      data-testid={`ux-run-${plan.id}`}
    >
      {busy || running ? (
        <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
      ) : (
        <Icon.Play size={11} />
      )}{' '}
      {running ? 'Running…' : label}
    </button>
  );
}

function UxHealthPill({ surface }: { surface: UxSurface }): ReactElement {
  const text =
    surface.uxHealth === 'unswept'
      ? 'Not swept'
      : surface.uxHealth === 'attention'
        ? `${surface.openFindings} to address`
        : 'Healthy';
  return <span className={`ux-health-pill ux-health-pill-${surface.uxHealth}`}>{text}</span>;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bad';
}): ReactElement {
  return (
    <div
      className={`coverage-feature-card-stat${tone ? ` coverage-feature-card-stat-${tone}` : ''}`}
    >
      <div className="coverage-feature-card-stat-label">{label}</div>
      <div className="coverage-feature-card-stat-value">{value}</div>
    </div>
  );
}

function severitySummary(s: UxSurface): string {
  const { P0, P1, P2 } = s.bySeverity;
  if (P0 + P1 + P2 === 0) return '—';
  return `${P0}·${P1}·${P2}`;
}

function attentionCount(surfaces: UxSurface[]): number {
  return surfaces.filter((s) => s.uxHealth === 'attention').length;
}

function openDebt(surfaces: UxSurface[]): number {
  return surfaces.reduce((sum, s) => sum + s.openFindings, 0);
}
