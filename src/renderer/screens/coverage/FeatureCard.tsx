import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { showApiAlert } from '../../state/alert-store';
import { runAgentByName } from '../../state/agent-actions';
import { ModelSelect } from '../../components/ModelSelect';
import { labelForAgent } from '../../format';
import { useClickOutside } from '../../hooks/useClickOutside';
import type {
  AgentName,
  CoverageFeature,
  IpcMap,
  RunnerKind,
  TestPlanGenerationJob,
  TestPlanRef,
  TestPlanSummary,
} from '../../../shared/types';

export type RunnerInstalled = IpcMap['runners:installed']['res'];
export type ActiveRun = IpcMap['runs:activeForRepo']['res'][number];

/** Match the live run (if any) that owns `(plan, agent)` on this repo. */
export function findActiveRun(
  activeRuns: ActiveRun[],
  planId: string,
  agentName: AgentName,
): ActiveRun | null {
  const taskRef = `plan:${planId}`;
  return activeRuns.find((r) => r.taskRef === taskRef && r.agentName === agentName) ?? null;
}

interface Props {
  repoId: string;
  feature: CoverageFeature;
  selected: boolean;
  installed: RunnerInstalled | null;
  /**
   * Live (queued/running/publishing/paused) runs for this repo. Each
   * (agent × plan) row matches against this list by `taskRef ===
   * 'plan:<planId>'` AND `agentName === <agent>` so the card reflects
   * in-flight work that started in another window or before mount.
   */
  activeRuns: ActiveRun[];
  /**
   * In-flight test plan generation job for this feature, if any. When set,
   * the "Generate test plan" button is disabled and shows the stage label
   * (e.g. "Reading codebase…") so the user can't kick off duplicate jobs
   * and stale tabs reflect background work that started elsewhere.
   */
  planJob: TestPlanGenerationJob | null;
  onSelect: () => void;
  onChange: () => void;
}

export function FeatureCard({
  repoId,
  feature,
  selected,
  installed,
  activeRuns,
  planJob,
  onSelect,
  onChange,
}: Props): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const generating = planJob !== null;
  const generateLabel = generating ? stageLabel(planJob) : 'Generate test plan';

  /** Attach-existing-plan picker state. */
  const [attachOpen, setAttachOpen] = useState(false);
  const [allPlans, setAllPlans] = useState<TestPlanSummary[] | null>(null);
  const attachRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!attachOpen) return;
    let cancelled = false;
    void window.obelisk.invoke('testPlans:list', { repoId }).then((res) => {
      if (cancelled) return;
      if (res.ok) setAllPlans(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [attachOpen, repoId]);
  const closeAttach = useCallback(() => setAttachOpen(false), []);
  useClickOutside(attachOpen, attachRef, closeAttach);

  async function handleAttachPlan(planId: string): Promise<void> {
    setBusy('attach');
    setAttachOpen(false);
    try {
      const get = await window.obelisk.invoke('testPlans:get', { repoId, planId });
      if (!get.ok) {
        showApiAlert(get.error, 'attach plan');
        return;
      }
      const res = await window.obelisk.invoke('testPlans:save', {
        repoId,
        planId,
        blocks: get.value.blocks,
        feature: feature.label,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'attach plan');
      } else {
        onChange();
      }
    } finally {
      setBusy(null);
    }
  }

  const hasPlan = feature.planRefs.length > 0;
  const runnersOk = installed ? installed.claude.installed || installed.codex.installed : null;
  const runnersHint =
    installed && !runnersOk
      ? (installed.claude.hint ?? installed.codex.hint ?? 'No coding-agent CLI on PATH.')
      : null;

  async function handleGenerate(): Promise<void> {
    if (generating) return; // hard guard against double-clicks
    setBusy('generate');
    try {
      const res = await window.obelisk.invoke('testPlans:generate', {
        repoId,
        agentName: 'qa-hunter',
        scope: 'feature',
        featureName: feature.label,
        focusOnChangedOrUncovered: true,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'generate test plan');
      } else {
        onChange();
      }
    } finally {
      setBusy(null);
    }
  }

  const tone = toneForPct(feature.coveragePct);

  // Flatten plan × agentNames into the rows the card renders. Order: by plan
  // updatedAt desc (already pre-sorted in aggregate.ts), then by agent type
  // so visual order is stable across renders.
  const runRows: { plan: TestPlanRef; agentName: AgentName }[] = [];
  for (const plan of feature.planRefs) {
    for (const agentName of plan.agentNames) {
      runRows.push({ plan, agentName });
    }
  }

  return (
    <div
      className={`coverage-feature-card coverage-feature-card-${tone}${
        selected ? ' selected' : ''
      }`}
    >
      <button
        type="button"
        className="coverage-feature-card-head"
        onClick={onSelect}
        title={selected ? 'Clear selection' : 'Show this feature’s files below'}
      >
        <div className="coverage-feature-card-label">{feature.label}</div>
        <div className="coverage-feature-card-pct">{feature.coveragePct}%</div>
      </button>

      <div className="coverage-feature-card-bar">
        <div
          className="coverage-feature-card-bar-fill"
          style={{ width: `${feature.coveragePct}%` }}
        />
      </div>

      <div className="coverage-feature-card-stats">
        <Stat
          label="Files"
          value={`${feature.filesWithCases}/${feature.filesInGlob}`}
          hint="Files in this feature's glob that have at least one test case"
        />
        <Stat
          label="Fresh"
          value={String(feature.filesRecentPass)}
          hint="Files passed within 14 days with no churn since"
        />
        <Stat
          label="Findings"
          value={String(feature.openFindings)}
          tone={feature.openFindings > 0 ? 'bad' : undefined}
          hint="Open findings touching this feature"
        />
      </div>

      <div className="coverage-feature-card-actions">
        {!hasPlan ? (
          <>
            <button
              type="button"
              className="btn primary sm"
              disabled={busy !== null || generating || installed === null || !runnersOk}
              onClick={handleGenerate}
              title={
                generating
                  ? `Already generating a test plan for ${feature.label} — ${planJob!.status}`
                  : (runnersHint ?? 'Generate a test plan scoped to this feature')
              }
              data-testid={`feature-card-generate-${feature.label}`}
              data-generating={generating ? 'true' : 'false'}
            >
              {busy === 'generate' || generating ? (
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Sparkles size={11} />
              )}{' '}
              {generateLabel}
            </button>
            <div className="coverage-feature-card-attach-wrap" ref={attachRef}>
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null || generating}
                onClick={() => setAttachOpen((v) => !v)}
                title="Bind an existing test plan to this feature"
                data-testid={`feature-card-attach-${feature.label}`}
              >
                {busy === 'attach' ? (
                  <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
                ) : null}{' '}
                Attach existing ▾
              </button>
              {attachOpen ? (
                <div className="coverage-feature-card-attach-pop">
                  {allPlans === null ? (
                    <div className="coverage-feature-card-attach-empty">Loading…</div>
                  ) : allPlans.length === 0 ? (
                    <div className="coverage-feature-card-attach-empty">
                      No plans in this repo yet.
                    </div>
                  ) : (
                    allPlans.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="coverage-feature-card-attach-row"
                        onClick={() => void handleAttachPlan(p.id)}
                      >
                        <div className="coverage-feature-card-attach-name">{p.name}</div>
                        <div className="coverage-feature-card-attach-meta">
                          {p.caseCount} case{p.caseCount === 1 ? '' : 's'} ·{' '}
                          {p.scope === 'feature' && p.feature ? p.feature : 'whole app'}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="coverage-feature-card-runs">
            {runRows.map(({ plan, agentName }) => (
              <RunRow
                key={`${plan.id}:${agentName}`}
                repoId={repoId}
                featureLabel={feature.label}
                plan={plan}
                agentName={agentName}
                installed={installed}
                runnersOk={runnersOk}
                runnersHint={runnersHint}
                activeRun={findActiveRun(activeRuns, plan.id, agentName)}
                onChange={onChange}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface RunRowProps {
  repoId: string;
  featureLabel: string;
  plan: TestPlanRef;
  agentName: AgentName;
  installed: RunnerInstalled | null;
  runnersOk: boolean | null;
  runnersHint: string | null;
  activeRun: ActiveRun | null;
  onChange: () => void;
}

/**
 * One run lane on a feature card. Reads "▶ <Agent> · <Plan name>" when idle,
 * morphs into "⟳ <Agent> · <Plan name> · Running…" when the live-runs prop
 * indicates this exact (plan, agent) pair is in flight. Clicking the idle
 * trigger opens a popover that lets the user pick a one-shot runner + model
 * before dispatching — first click never starts a run.
 */
export function RunRow({
  repoId,
  featureLabel,
  plan,
  agentName,
  installed,
  runnersOk,
  runnersHint,
  activeRun,
  onChange,
}: RunRowProps): ReactElement {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** '' = "use whatever the agent row / repo default already says". */
  const [runner, setRunner] = useState<'' | RunnerKind>('');
  const [model, setModel] = useState<string>('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useCallback(() => setPopoverOpen(false), []);
  useClickOutside(popoverOpen, wrapRef, closePopover);

  const agentLabel = labelForAgent(agentName);
  const running = activeRun !== null;
  const disabled = busy || installed === null || !runnersOk;

  async function handleRun(): Promise<void> {
    setBusy(true);
    try {
      const res = await runAgentByName(repoId, agentName, {
        taskId: `plan:${plan.id}`,
        ...(runner ? { runnerOverride: runner } : {}),
        ...(model ? { modelOverride: model } : {}),
      });
      if (!res.ok) {
        showApiAlert(res.error, 'run agent');
      } else {
        setPopoverOpen(false);
        onChange();
      }
    } finally {
      setBusy(false);
    }
  }

  const triggerTitle = running
    ? `${agentLabel} is already running on "${plan.name}" — wait for it to finish before starting another.`
    : (runnersHint ?? `Run ${agentLabel} against "${plan.name}" for ${featureLabel}`);

  return (
    <div
      className={`coverage-feature-card-run-row${running ? ' running' : ''}`}
      ref={wrapRef}
      data-testid={`feature-card-run-${featureLabel}-${agentName}-${plan.id}`}
    >
      <button
        type="button"
        className="coverage-feature-card-run-trigger"
        disabled={running || disabled}
        onClick={() => setPopoverOpen((v) => !v)}
        title={triggerTitle}
      >
        <span className="coverage-feature-card-run-icon">
          {running ? (
            <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
          ) : (
            <Icon.Play size={11} />
          )}
        </span>
        <span className="coverage-feature-card-run-agent">{agentLabel}</span>
        <span className="coverage-feature-card-run-sep">·</span>
        <span className="coverage-feature-card-run-plan" title={plan.name}>
          {plan.name}
        </span>
        {running ? <span className="coverage-feature-card-run-status">Running…</span> : null}
      </button>
      {popoverOpen && !running ? (
        <div className="coverage-feature-card-run-pop">
          <div className="coverage-feature-card-run-pop-head">
            Run <strong>{agentLabel}</strong> on <strong>{plan.name}</strong>
          </div>
          <label className="coverage-feature-card-run-pop-label">
            Runner
            <select
              className="file-issue-input"
              value={runner}
              onChange={(e) => {
                const next = e.target.value as '' | RunnerKind;
                setRunner(next);
                setModel(''); // reset model when the runner changes
              }}
            >
              <option value="">Use default</option>
              <option value="claude" disabled={!installed?.claude.installed}>
                Claude Code{installed?.claude.installed ? '' : ' (not installed)'}
              </option>
              <option value="codex" disabled={!installed?.codex.installed}>
                Codex{installed?.codex.installed ? '' : ' (not installed)'}
              </option>
            </select>
          </label>
          <label className="coverage-feature-card-run-pop-label">
            Model
            <ModelSelect runner={runner} value={model} onChange={setModel} disabled={busy} />
          </label>
          <div className="coverage-feature-card-run-pop-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => setPopoverOpen(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void handleRun()}
              disabled={disabled}
            >
              {busy ? (
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Play size={11} />
              )}{' '}
              Run
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'bad';
  hint: string;
}): ReactElement {
  return (
    <div
      className={`coverage-feature-card-stat${tone ? ` coverage-feature-card-stat-${tone}` : ''}`}
      title={hint}
    >
      <div className="coverage-feature-card-stat-label">{label}</div>
      <div className="coverage-feature-card-stat-value">{value}</div>
    </div>
  );
}

function stageLabel(job: TestPlanGenerationJob): string {
  switch (job.stage) {
    case 'queued':
      return 'Queued…';
    case 'spawning':
      return 'Starting…';
    case 'reading':
      return 'Reading codebase…';
    case 'drafting':
      return 'Drafting cases…';
    case 'writing':
      return 'Saving plan…';
    default:
      return 'Generating…';
  }
}

function toneForPct(pct: number): 'ok' | 'mid' | 'bad' {
  if (pct >= 70) return 'ok';
  if (pct >= 40) return 'mid';
  return 'bad';
}
