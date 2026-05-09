import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import type {
  Agent,
  BacklogItem,
  IpcMap,
  Run,
  RunState,
  AgentName,
  SafetyMode,
  PreviewedFinding,
} from '../../shared/types';
import { Icon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { FindingPreview } from '../components/FindingPreview';
import { FileIssueModal } from '../components/FileIssueModal';
import {
  PlanGateDialog,
  gateStateFor,
  QA_AGENT_NAMES_FOR_GATE,
  type PlanGateState,
} from '../components/PlanGateDialog';
import { labelForAgent } from '../format';

type PreviewsResponse = IpcMap['previews:list']['res'];

/** Agents that need a preflight (Doctor green) before Run is meaningful. */
const PREFLIGHT_AGENTS: ReadonlySet<AgentName> = new Set(['ios-qa-pilot', 'manual-qa']);

/**
 * Home (Project Command Center).
 * Read-only summary built from real DB queries via IPC.
 */

const LIVE_STATES: RunState[] = ['queued', 'running', 'publishing', 'paused'];

export function Home(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const auth = useStore((s) => s.auth);
  const setRoute = useStore((s) => s.setRoute);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [agents, setAgents] = useState<Agent[]>([]);
  // Runs live in the global store so they update in real time off the bus
  // (run.created / run.transition / run.deleted) — the KPI card and Recent
  // runs list re-render without needing a route change.
  const allRuns = useStore((s) => s.runs);
  const upsertRun = useStore((s) => s.upsertRun);
  const runs = useMemo(() => {
    if (!repo) return [] as Run[];
    return Object.values(allRuns)
      .filter((r) => r.repoId === repo.id)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }, [allRuns, repo]);
  // Map agentId → live run so the Run/Stop toggle on each agent row knows
  // whether there's an in-flight run to stop, instead of letting the user
  // press a Run button that would silently fail with RUN_ACTIVE.
  const liveRunByAgentId = useMemo(() => {
    const m = new Map<string, Run>();
    for (const r of runs) {
      if (LIVE_STATES.includes(r.state) && r.agentId) m.set(r.agentId, r);
    }
    return m;
  }, [runs]);
  const stopRun = useCallback(async (runId: string): Promise<void> => {
    const res = await window.obelisk.invoke('agents:cancel', { runId });
    if (!res.ok) alert(`Couldn't stop run: ${res.error.message}`);
  }, []);
  const [backlog, setBacklog] = useState<BacklogItem[]>([]);
  const [previews, setPreviews] = useState<PreviewsResponse>({
    findings: [],
    playbookDraft: null,
  });
  const [modalFinding, setModalFinding] = useState<PreviewedFinding | null>(null);
  const [runState, setRunState] = useState<{
    pending: Set<string>;
    error: { agentId: string; message: string; hint?: string } | null;
  }>({ pending: new Set(), error: null });
  const [planGate, setPlanGate] = useState<PlanGateState>({ kind: 'closed' });

  const refreshPreviews = useCallback(async () => {
    if (!repo) return;
    const p = await window.obelisk.invoke('previews:list', { repoId: repo.id });
    if (p.ok) setPreviews(p.value);
  }, [repo]);

  useEffect(() => {
    if (!repo) return;
    void Promise.all([
      window.obelisk.invoke('agents:list', { repoId: repo.id }),
      window.obelisk.invoke('runs:list', { repoId: repo.id, limit: 50 }),
      window.obelisk.invoke('backlog:list', { repoId: repo.id }),
      window.obelisk.invoke('previews:list', { repoId: repo.id }),
    ]).then(([a, r, b, p]) => {
      if (a.ok) setAgents(a.value);
      if (r.ok) for (const run of r.value) upsertRun(run);
      if (b.ok) setBacklog(b.value);
      if (p.ok) setPreviews(p.value);
    });
  }, [repo, upsertRun]);

  // Real-time updates while the user stays on this screen:
  //  · previews.changed → refresh the findings list
  //  · backlog.changed  → refresh the "Up next" table
  //  · run.* events flow through the global store via bus-subscriber, so
  //    `runs` (selected from the store) re-renders on its own.
  useEffect(() => {
    if (!repo) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'previews.changed' && evt.repoId === repo.id) {
        void refreshPreviews();
        return;
      }
      if (evt.type === 'backlog.changed' && evt.repoId === repo.id) {
        void window.obelisk.invoke('backlog:list', { repoId: repo.id }).then((b) => {
          if (b.ok) setBacklog(b.value);
        });
      }
    });
  }, [repo, refreshPreviews]);

  const dispatchRun = useCallback(
    async (a: Agent, taskId?: string) => {
      const res = await window.obelisk.invoke('agents:run', {
        agentId: a.id,
        ...(taskId ? { taskId } : {}),
      });
      if (res.ok) {
        setRunState({ pending: new Set(), error: null });
        setRoute('mission');
        return;
      }
      setRunState((s) => {
        const pending = new Set(s.pending);
        pending.delete(a.id);
        return {
          pending,
          error: {
            agentId: a.id,
            message: res.error.message,
            ...(res.error.hint ? { hint: res.error.hint } : {}),
          },
        };
      });
    },
    [setRoute],
  );

  const runAgent = useCallback(
    async (a: Agent) => {
      setRunState((s) => ({
        pending: new Set([...s.pending, a.id]),
        error: null,
      }));
      try {
        if (PREFLIGHT_AGENTS.has(a.name)) {
          const doctorRes = await window.obelisk.invoke('qa:doctor', { repoId: a.repoId });
          if (!doctorRes.ok) {
            setRunState((s) => {
              const pending = new Set(s.pending);
              pending.delete(a.id);
              return {
                pending,
                error: { agentId: a.id, message: doctorRes.error.message },
              };
            });
            return;
          }
          if (doctorRes.value.overall !== 'green') {
            setRunState((s) => {
              const pending = new Set(s.pending);
              pending.delete(a.id);
              return { pending, error: null };
            });
            setRoute('qa');
            return;
          }
        }

        // QA agents must have an assigned test plan. Gate at this layer so
        // the orchestrator never sees a plan-less invocation.
        if (QA_AGENT_NAMES_FOR_GATE.has(a.name)) {
          const plansRes = await window.obelisk.invoke('testPlans:list', {
            repoId: a.repoId,
            agentName: a.name,
          });
          if (!plansRes.ok) {
            setRunState((s) => {
              const pending = new Set(s.pending);
              pending.delete(a.id);
              return {
                pending,
                error: { agentId: a.id, message: plansRes.error.message },
              };
            });
            return;
          }
          const next = gateStateFor({ agent: a, plans: plansRes.value });
          if (next.kind !== 'closed') {
            setRunState((s) => {
              const pending = new Set(s.pending);
              pending.delete(a.id);
              return { pending, error: null };
            });
            setPlanGate(next);
            return;
          }
          // Exactly one plan → use it without a picker.
          await dispatchRun(a, `plan:${plansRes.value[0]!.id}`);
          return;
        }

        await dispatchRun(a);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setRunState((s) => {
          const pending = new Set(s.pending);
          pending.delete(a.id);
          return { pending, error: { agentId: a.id, message } };
        });
      }
    },
    [setRoute, dispatchRun],
  );

  const generatePlanFromGate = useCallback(
    async (input: { scope: 'whole-app' | 'feature'; featureName?: string }) => {
      if (planGate.kind !== 'newPlanForm') return;
      const agent = planGate.agent;
      setPlanGate({ ...planGate, busy: true, error: null });
      const res = await window.obelisk.invoke('testPlans:generate', {
        repoId: agent.repoId,
        agentName: agent.name,
        scope: input.scope,
        ...(input.featureName ? { featureName: input.featureName } : {}),
      });
      if (!res.ok) {
        setPlanGate({ ...planGate, busy: false, error: res.error.message });
        return;
      }
      // Generation runs in the background; close the modal and let the
      // floating toast surface progress + the "Open" CTA on completion.
      setPlanGate({ kind: 'closed' });
    },
    [planGate],
  );

  const onPickFromGate = useCallback(
    async (planId: string) => {
      if (planGate.kind !== 'pick') return;
      const agent = planGate.agent;
      setPlanGate({ kind: 'closed' });
      await dispatchRun(agent, `plan:${planId}`);
    },
    [planGate, dispatchRun],
  );

  const onAddNewFromPicker = useCallback(() => {
    if (planGate.kind !== 'pick') return;
    setPlanGate({
      kind: 'newPlanForm',
      agent: planGate.agent,
      scope: 'whole-app',
      featureName: '',
      busy: false,
      error: null,
    });
  }, [planGate]);

  const advanceFromNoPlan = useCallback(() => {
    if (planGate.kind !== 'noPlan') return;
    setPlanGate({
      kind: 'newPlanForm',
      agent: planGate.agent,
      scope: 'whole-app',
      featureName: '',
      busy: false,
      error: null,
    });
  }, [planGate]);

  const dismissRunError = useCallback(() => {
    setRunState((s) => ({ pending: s.pending, error: null }));
  }, []);

  const dismissPreview = useCallback(async (f: PreviewedFinding) => {
    const res = await window.obelisk.invoke('previews:dismiss', { previewId: f.id });
    if (!res.ok) alert(res.error.message);
  }, []);

  const kpis = useMemo(() => {
    const liveRuns = runs.filter((r) => LIVE_STATES.includes(r.state)).length;
    const doneToday = runs.filter((r) => r.state === 'done' && isToday(r.finishedAt)).length;
    const failedRecent = runs.filter((r) => r.state === 'failed').length;
    return { liveRuns, doneToday, failedRecent, backlogTotal: backlog.length };
  }, [runs, backlog]);

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Connect a GitHub repo to start running agents against it."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => setRoute('connect'),
        }}
      />
    );
  }

  const greeting = greet(auth.login ?? 'there');

  return (
    <div className="home">
      <div>
        <div className="home-greeting">{greeting}</div>
        <div className="home-sub">
          {repo.githubFullName} · safety: <span className="mono">{repo.mode}</span> · runner
          default: <span className="mono">{repo.defaultRunner}</span>
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard
          label="Live runs"
          value={kpis.liveRuns}
          sub={kpis.liveRuns === 0 ? 'idle' : 'see Mission Control'}
        />
        <KpiCard label="Done today" value={kpis.doneToday} sub="last 24h" />
        <KpiCard label="Failed (recent)" value={kpis.failedRecent} sub="last 50 runs" />
        <KpiCard label="Backlog" value={kpis.backlogTotal} sub="items waiting" />
      </div>

      <div className="home-section">
        <div className="home-section-title">
          Agents
          <span className="row gap-1" style={{ alignItems: 'center' }}>
            <AgentLegendButton />
            <button type="button" className="btn ghost sm" onClick={() => setRoute('agents')}>
              Configure
            </button>
          </span>
        </div>
        {repo.mode === 'observe' ? (
          <div className="home-section-sub" style={{ marginBottom: 8 }}>
            Agents run on schedule but write previews here, not GitHub. Switch to{' '}
            <button
              type="button"
              className="btn ghost sm"
              style={{ display: 'inline', padding: '0 4px' }}
              onClick={() => setRoute('settings')}
            >
              File issues
            </button>{' '}
            to publish.
          </div>
        ) : null}
        {agents.length === 0 ? (
          <div className="home-table-empty">No agents installed.</div>
        ) : (
          <div className="home-table">
            {agents.map((a) => {
              const status = agentRunStatus(a, repo.mode);
              const tooltip = `${status.label} — ${status.description}`;
              return (
                <div key={a.id} className="home-table-row">
                  <span className="dot" style={{ background: status.dotColor }} title={tooltip} />
                  <div className="home-table-row-body">
                    <div style={{ fontWeight: 600 }}>{a.displayName}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                      {labelForAgent(a.name)} · {a.runnerOverride ?? repo.defaultRunner} ·{' '}
                      {scheduleSummary(a)}
                    </div>
                  </div>
                  <div className="home-table-row-actions">
                    {liveRunByAgentId.get(a.id) ? (
                      <StopRunButton
                        agent={a}
                        runId={liveRunByAgentId.get(a.id)!.id}
                        onStop={stopRun}
                      />
                    ) : (
                      <RunButton
                        agent={a}
                        pending={runState.pending.has(a.id)}
                        onRun={() => void runAgent(a)}
                        variant="ghost"
                      />
                    )}
                    <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                      {a.timeoutMs / 1000 / 60}m timeout
                    </span>
                    <span
                      className={`pill ${status.tone}`}
                      title={tooltip}
                      style={{ cursor: 'help' }}
                    >
                      {status.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {repo.mode === 'observe' ? (
        <ObservePreviews
          findings={previews.findings}
          repoMode={repo.mode}
          installedAgents={agents}
          runState={runState}
          onUpgradeMode={() => setRoute('settings')}
          onOpenTestPlans={() => setRoute('test-plans')}
          onOpenFinding={setModalFinding}
          onDismissFinding={dismissPreview}
          onRunAgent={runAgent}
          onDismissError={dismissRunError}
        />
      ) : null}

      <div className="home-section">
        <div className="home-section-title">
          Recent runs
          <button type="button" className="btn ghost sm" onClick={() => setRoute('mission')}>
            Open Mission Control
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="home-table-empty">No runs yet. Trigger one from Mission Control.</div>
        ) : (
          <div className="home-table">
            {runs.slice(0, 8).map((r) => {
              const canCancel = r.state === 'queued' || r.state === 'running';
              return (
                <div key={r.id} className="home-table-row">
                  <Icon.Pipeline size={14} color="var(--t-2)" />
                  <div className="home-table-row-body">
                    <div style={{ fontWeight: 600 }}>{r.taskRef ?? '(no task ref)'}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                      {labelForAgent(r.agentName)} · {r.runnerUsed} · {r.outputSummary ?? '—'}
                    </div>
                  </div>
                  <div className="home-table-row-actions">
                    <span className={`pill ${stateTone(r.state)}`}>{r.state}</span>
                    <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                      {r.startedAt ? short(r.startedAt) : ''}
                    </span>
                    {canCancel ? (
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="Stop this run"
                        onClick={async () => {
                          const res = await window.obelisk.invoke('agents:cancel', { runId: r.id });
                          if (!res.ok) alert(`Couldn't stop run: ${res.error.message}`);
                        }}
                      >
                        <Icon.Pause size={11} /> Stop
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="home-section">
        <div className="home-section-title">
          Up next
          <button type="button" className="btn ghost sm" onClick={() => setRoute('backlog')}>
            Open Backlog
          </button>
        </div>
        {backlog.length === 0 ? (
          <div className="home-table-empty">Backlog is empty.</div>
        ) : (
          <div className="home-table">
            {backlog.slice(0, 6).map((b) => (
              <div key={b.id} className="home-table-row">
                <Icon.Backlog size={14} color="var(--t-2)" />
                <div className="home-table-row-body">
                  <div style={{ fontWeight: 600 }}>{b.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                    {b.kind} · {b.priorityLabel ?? 'no priority'} ·{' '}
                    {b.githubIssue ? `#${b.githubIssue}` : 'manual'}
                  </div>
                </div>
                <div className="home-table-row-actions">
                  <span
                    className={`pill ${b.priorityLabel === 'P0' ? 'bad' : b.priorityLabel === 'P1' ? 'warn' : ''}`}
                  >
                    {b.priorityLabel ?? '—'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                    {b.inProgressRun ? 'in flight' : 'queued'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <FileIssueModal
        open={modalFinding !== null}
        finding={modalFinding}
        onClose={() => setModalFinding(null)}
        onFiled={() => {
          // Bus broadcast will refresh; nothing extra needed here.
        }}
      />
      <PlanGateDialog
        state={planGate}
        onClose={() => setPlanGate({ kind: 'closed' })}
        onAdvanceFromNoPlan={advanceFromNoPlan}
        onGenerate={(input) => void generatePlanFromGate(input)}
        onPick={(planId) => void onPickFromGate(planId)}
        onAddNewFromPicker={onAddNewFromPicker}
      />
    </div>
  );
}

function AgentLegendButton(): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows = useMemo(() => buildLegend(), []);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn ghost sm icon"
        onClick={() => setOpen((v) => !v)}
        title="Agent state legend"
        aria-label="Agent state legend"
        aria-expanded={open}
      >
        <Icon.Help size={13} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Agent states"
          className="card"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 340,
            padding: 12,
            zIndex: 20,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Agent states</div>
          <div className="col" style={{ gap: 8 }}>
            {rows.map((r) => (
              <div key={r.label} className="row gap-2" style={{ alignItems: 'flex-start' }}>
                <span
                  className="dot"
                  style={{ background: r.dotColor, marginTop: 5, flexShrink: 0 }}
                />
                <div className="col" style={{ gap: 2, flex: 1 }}>
                  <div className="row gap-2" style={{ alignItems: 'center' }}>
                    <span className={`pill ${r.tone}`}>{r.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t-2)', lineHeight: 1.4 }}>
                    {r.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px solid var(--bg-3)',
              fontSize: 11,
              color: 'var(--t-3)',
            }}
          >
            The state shown on each agent reflects the repo&apos;s current safety mode. Change it in
            Settings to escalate or de-escalate every agent at once.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub: string;
}): ReactElement {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

const QA_AGENT_NAMES: AgentName[] = ['qa-hunter', 'manual-qa', 'ios-qa-pilot'];

interface RunStateMap {
  pending: Set<string>;
  error: { agentId: string; message: string; hint?: string } | null;
}

function StopRunButton({
  agent,
  runId,
  onStop,
}: {
  agent: Agent;
  runId: string;
  onStop: (runId: string) => Promise<void>;
}): ReactElement {
  const [stopping, setStopping] = useState(false);
  return (
    <button
      type="button"
      className="btn sm danger"
      disabled={stopping}
      title={`Cancel the in-flight ${agent.displayName} run`}
      data-testid={`stop-${agent.name}`}
      onClick={async () => {
        setStopping(true);
        try {
          await onStop(runId);
        } finally {
          setStopping(false);
        }
      }}
    >
      {stopping ? (
        <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
      ) : (
        <Icon.Pause size={11} />
      )}{' '}
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  );
}

function RunButton({
  agent,
  pending,
  onRun,
  variant,
}: {
  agent: Agent;
  pending: boolean;
  onRun: () => void;
  variant: 'ghost' | 'primary';
}): ReactElement {
  const baseClass = variant === 'primary' ? 'btn primary sm' : 'btn ghost sm';
  return (
    <button
      type="button"
      className={baseClass}
      onClick={onRun}
      disabled={pending}
      title={
        pending
          ? `Starting ${agent.displayName}…`
          : PREFLIGHT_AGENTS.has(agent.name)
            ? `Run ${agent.displayName} now (preflight required)`
            : `Run ${agent.displayName} now`
      }
      data-testid={`run-${agent.name}`}
    >
      {pending ? (
        <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
      ) : (
        <Icon.Play size={11} />
      )}{' '}
      {pending ? 'Starting…' : variant === 'primary' ? `Run ${labelForAgent(agent.name)}` : 'Run'}
    </button>
  );
}

function ObservePreviews({
  findings,
  installedAgents,
  runState,
  onUpgradeMode,
  onOpenTestPlans,
  onOpenFinding,
  onDismissFinding,
  onRunAgent,
  onDismissError,
}: {
  findings: PreviewsResponse['findings'];
  repoMode: SafetyMode;
  installedAgents: Agent[];
  runState: RunStateMap;
  onUpgradeMode: () => void;
  onOpenTestPlans: () => void;
  onOpenFinding: (f: PreviewedFinding) => void;
  onDismissFinding: (f: PreviewedFinding) => void;
  onRunAgent: (a: Agent) => Promise<void> | void;
  onDismissError: () => void;
}): ReactElement {
  const visible = findings.filter((f) => !f.dismissed);
  const qaAgents = installedAgents.filter((a) => QA_AGENT_NAMES.includes(a.name));
  return (
    <div className="home-section observe-previews">
      <div className="home-section-title">
        <span className="row gap-2" style={{ alignItems: 'center' }}>
          <Icon.Eye size={13} color="var(--brand)" />
          Observe-mode previews
        </span>
        <button type="button" className="btn ghost sm" onClick={onUpgradeMode}>
          Switch to &ldquo;File issues&rdquo; mode
        </button>
      </div>
      <div className="home-section-sub">
        Safety mode is set to <span className="mono">observe</span>, so nothing has been written to
        GitHub. Findings show up here — review and click <em>Open issue</em> to file each one.
      </div>

      {runState.error ? (
        <div className="observe-error" role="alert" data-testid="run-error">
          <div className="observe-error-icon">
            <Icon.AlertTri size={13} />
          </div>
          <div className="observe-error-body">
            <div className="observe-error-title">Could not start agent</div>
            <div className="observe-error-msg">{runState.error.message}</div>
            {runState.error.hint ? (
              <div className="observe-error-hint">{runState.error.hint}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn ghost icon"
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            <Icon.Close size={11} />
          </button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="observe-empty">
          <div className="observe-empty-title">No findings yet</div>
          <div className="observe-empty-sub">
            Pick a QA agent and a test plan; the agent runs, surfaces bugs here, and you choose
            which to file as GitHub issues.
          </div>
          <div className="row gap-2 observe-empty-actions">
            {qaAgents.length === 0 ? (
              <span className="observe-empty-hint">
                No QA agents installed. Add one from <em>Configure</em>.
              </span>
            ) : (
              <>
                {qaAgents.map((a) => (
                  <RunButton
                    key={a.id}
                    agent={a}
                    pending={runState.pending.has(a.id)}
                    onRun={() => void onRunAgent(a)}
                    variant="primary"
                  />
                ))}
                <button type="button" className="btn ghost sm" onClick={onOpenTestPlans}>
                  <Icon.Doc size={11} /> Manage test plans
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="finding-list">
          {visible.map((f) => (
            <FindingPreview
              key={f.id}
              finding={f}
              onOpen={onOpenFinding}
              onDismiss={onDismissFinding}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AgentRunStatus {
  label: string;
  tone: '' | 'ok' | 'warn' | 'bad' | 'info';
  dotColor: string;
  description: string;
}

/**
 * What "enabled" actually means for the user, given the repo's safety mode.
 * In Observe, scheduled runs only preview to the audit log — calling that
 * "enabled" is misleading, hence the per-mode relabel.
 */
function agentRunStatus(agent: Agent, mode: SafetyMode): AgentRunStatus {
  if (!agent.enabled) {
    return {
      label: 'Paused',
      tone: '',
      dotColor: 'var(--t-3)',
      description: 'Disabled. Will not run on schedule or via "Run all".',
    };
  }
  switch (mode) {
    case 'observe':
      return {
        label: 'Previewing',
        tone: 'info',
        dotColor: 'var(--info)',
        description:
          'Runs on schedule and writes findings as previews here. Nothing is published to GitHub while safety mode is Observe.',
      };
    case 'issues':
      return {
        label: 'Filing issues',
        tone: 'ok',
        dotColor: 'var(--ok)',
        description:
          'Runs on schedule and files GitHub issues for findings (no code changes). PR-opening agents stay limited to issues until you raise the safety mode.',
      };
    case 'prs':
      return {
        label: 'Opening PRs',
        tone: 'warn',
        dotColor: 'var(--warn)',
        description:
          'Runs on schedule and opens PRs ready for your review and merge. Issue-only agents still file issues.',
      };
    case 'automerge':
      return {
        label: 'Auto-merging',
        tone: 'bad',
        dotColor: 'var(--bad)',
        description:
          'Runs on schedule, opens PRs, and auto-merges the ones that meet the safety bar. Highest blast radius.',
      };
  }
}

const LEGEND_MODES: SafetyMode[] = ['observe', 'issues', 'prs', 'automerge'];

function buildLegend(): AgentRunStatus[] {
  // Reuse agentRunStatus so the legend can never drift from the real labels.
  const dummy: Agent = {
    id: '',
    repoId: '',
    name: 'qa-hunter',
    displayName: 'QA Hunter',
    enabled: true,
    runnerOverride: null,
    modelOverride: null,
    scheduleCron: null,
    schedule: null,
    timeoutMs: 0,
    permissions: {
      readCode: true,
      runTests: true,
      createIssues: true,
      draftPrs: false,
      merge: false,
    },
    createdAt: '',
    multiInstance: false,
  };
  const rows = LEGEND_MODES.map((m) => agentRunStatus(dummy, m));
  rows.push(agentRunStatus({ ...dummy, enabled: false }, 'observe'));
  return rows;
}

function scheduleSummary(agent: Agent): string {
  if (!agent.enabled) return 'paused';
  if (!agent.nextFireAt) return 'manual only';
  return `next ${formatNextFire(agent.nextFireAt)}`;
}

function formatNextFire(iso: string): string {
  const target = new Date(iso).getTime();
  const delta = target - Date.now();
  if (delta <= 0) return 'now';
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    // Same-day: show clock time, easier to scan than "in 5h"
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.round(hours / 24);
  if (days < 7) return `in ${days}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function stateTone(s: RunState): string {
  switch (s) {
    case 'done':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'paused':
      return 'warn';
    case 'cancelled':
      return '';
    default:
      return 'info';
  }
}

function greet(login: string): string {
  const h = new Date().getHours();
  const part =
    h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${login}`;
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function short(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
