import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { showApiAlert } from '../../state/alert-store';
import { runAgentByName } from '../../state/agent-actions';
import type {
  AgentName,
  CoverageFeature,
  IpcMap,
  TestPlanGenerationJob,
  TestPlanSummary,
} from '../../../shared/types';

export type RunnerInstalled = IpcMap['runners:installed']['res'];

interface Props {
  repoId: string;
  feature: CoverageFeature;
  selected: boolean;
  installed: RunnerInstalled | null;
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

/** Agents the run-now CTAs surface. iOS Pilot is offered only when a plan claims it. */
const COVERAGE_AGENTS: { name: AgentName; label: string }[] = [
  { name: 'qa-hunter', label: 'QA Hunter' },
  { name: 'ios-qa-pilot', label: 'iOS Pilot' },
  { name: 'manual-qa', label: 'Manual QA' },
];

export function FeatureCard({
  repoId,
  feature,
  selected,
  installed,
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
    function onDocClick(e: MouseEvent): void {
      if (!attachRef.current) return;
      if (!attachRef.current.contains(e.target as Node)) setAttachOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [attachOpen, repoId]);

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
  const agentNamesInPlans = useMemo(() => {
    const set = new Set<AgentName>();
    for (const p of feature.planRefs) for (const a of p.agentNames) set.add(a);
    return set;
  }, [feature.planRefs]);

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

  async function handleRun(agentName: AgentName): Promise<void> {
    setBusy(`run:${agentName}`);
    try {
      const plan = pickPlanForAgent(feature.planRefs, agentName);
      const taskId = plan ? `plan:${plan.id}` : undefined;
      const res = await runAgentByName(repoId, agentName, taskId);
      if (!res.ok) {
        showApiAlert(res.error, 'run agent');
      } else {
        onChange();
      }
    } finally {
      setBusy(null);
    }
  }

  const tone = toneForPct(feature.coveragePct);

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
          <>
            {COVERAGE_AGENTS.filter((a) => agentNamesInPlans.has(a.name)).map((a, i) => {
              const isBusy = busy === `run:${a.name}`;
              const disabled = busy !== null || installed === null || !runnersOk;
              return (
                <button
                  key={a.name}
                  type="button"
                  className={`btn sm${i === 0 ? ' primary' : ''}`}
                  disabled={disabled}
                  onClick={() => void handleRun(a.name)}
                  title={runnersHint ?? `Run ${a.label} against this feature's plan`}
                >
                  {isBusy ? (
                    <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
                  ) : (
                    <Icon.Play size={11} />
                  )}{' '}
                  {a.label}
                </button>
              );
            })}
          </>
        )}
      </div>

      {hasPlan ? (
        <div className="coverage-feature-card-plan" title={feature.planRefs[0]!.name}>
          {feature.planCount === 1
            ? `Plan: ${feature.planRefs[0]!.name}`
            : `${feature.planCount} plans cover this feature`}
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

function pickPlanForAgent(
  planRefs: CoverageFeature['planRefs'],
  agentName: AgentName,
): CoverageFeature['planRefs'][number] | null {
  const matching = planRefs.filter((p) => p.agentNames.includes(agentName));
  if (matching.length === 0) return null;
  // planRefs come pre-sorted desc by updatedAt from aggregate.ts.
  return matching[0]!;
}
