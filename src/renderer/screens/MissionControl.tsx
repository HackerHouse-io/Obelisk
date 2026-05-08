import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import { useClickOutside } from '../hooks/useClickOutside';
import { EmptyState } from '../ui/EmptyState';
import { FindingPreview } from '../components/FindingPreview';
import { FileIssueModal } from '../components/FileIssueModal';
import { RunnerLoginActionCard } from '../components/RunnerLoginActionCard';
import { labelForAgent } from '../format';
import type {
  Agent,
  AuditLine,
  CaseProgressState,
  EvidenceItem,
  Run,
  RunState,
  PreviewedFinding,
  TestPlan,
  TestPlanSummary,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { countByState, derivePerCaseState } from './mission-control-helpers';

/**
 * Mission Control: 7-stage pipeline + 460px right drawer with 4 tabs.
 * Reactive to bus events `run.transition` and `run.audit` via the Zustand store.
 */

type StageId = 'queued' | 'running' | 'publishing' | 'paused' | 'failed' | 'done' | 'cancelled';

interface StageDef {
  id: StageId;
  label: string;
  sub: string;
  matchState: RunState[];
  color: string;
}

const STAGES: StageDef[] = [
  {
    id: 'queued',
    label: 'Backlog',
    sub: 'Waiting to run',
    matchState: ['queued'],
    color: 'var(--t-2)',
  },
  {
    id: 'running',
    label: 'Investigating',
    sub: 'Reading code',
    matchState: ['running'],
    color: 'var(--info)',
  },
  {
    id: 'publishing',
    label: 'Publishing',
    sub: 'Evidence packed',
    matchState: ['publishing'],
    color: 'var(--brand)',
  },
  {
    id: 'paused',
    label: 'Paused',
    sub: 'Needs human input',
    matchState: ['paused'],
    color: 'var(--warn)',
  },
  { id: 'done', label: 'Done', sub: 'Shipped', matchState: ['done'], color: 'var(--ok)' },
  {
    id: 'cancelled',
    label: 'Cancelled',
    sub: 'Stopped by user',
    matchState: ['cancelled'],
    color: 'var(--t-3)',
  },
  {
    id: 'failed',
    label: 'Failed',
    sub: 'Investigate logs',
    matchState: ['failed'],
    color: 'var(--bad)',
  },
];

export function MissionControl(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const runs = useStore((s) => s.runs);
  const upsertRun = useStore((s) => s.upsertRun);
  const removeRun = useStore((s) => s.removeRun);
  const removeRunsByRepo = useStore((s) => s.removeRunsByRepo);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [planSummaries, setPlanSummaries] = useState<TestPlanSummary[]>([]);
  // Drawer always starts closed when the user navigates into Mission Control.
  // The previous build persisted this in localStorage and the drawer would
  // re-open on every screen entry once it had been opened — annoying when
  // the user just wants to scan the columns. The drawer still opens
  // automatically when a run is freshly started (obelisk:run-started) or
  // explicitly focused (obelisk:focus-run); see the effect below.
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  // Initial fetch.
  useEffect(() => {
    if (!repo) return;
    void window.obelisk.invoke('runs:list', { repoId: repo.id, limit: 100 }).then((res) => {
      if (res.ok) {
        for (const run of res.value) upsertRun(run);
      }
    });
    void window.obelisk.invoke('agents:list', { repoId: repo.id }).then((res) => {
      if (res.ok) setAgents(res.value);
    });
    void window.obelisk.invoke('testPlans:list', { repoId: repo.id }).then((res) => {
      if (res.ok) setPlanSummaries(res.value);
    });
  }, [repo, upsertRun]);

  // Keep plan-name lookups fresh so renaming a plan or deleting one is
  // reflected on the cards without a manual refresh.
  useEffect(() => {
    if (!repo) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'testPlans.changed' && evt.repoId === repo.id) {
        void window.obelisk.invoke('testPlans:list', { repoId: repo.id }).then((res) => {
          if (res.ok) setPlanSummaries(res.value);
        });
      }
    });
  }, [repo]);

  // Surface a freshly-started run: select it and pop the inspector. Fired by
  // the test-plan run button (and the run-started toast's "View" action).
  useEffect(() => {
    function onStarted(e: Event): void {
      const detail = (e as CustomEvent<{ runId?: string }>).detail;
      if (!detail?.runId) return;
      setSelectedRunId(detail.runId);
      setDrawerOpen(true);
      // The new run row may not be in the store yet — refresh so the card
      // shows up in the Investigating column right away.
      if (repo) {
        void window.obelisk.invoke('runs:list', { repoId: repo.id, limit: 100 }).then((res) => {
          if (res.ok) {
            for (const run of res.value) upsertRun(run);
          }
        });
      }
    }
    window.addEventListener('obelisk:run-started', onStarted);
    window.addEventListener('obelisk:focus-run', onStarted);
    return () => {
      window.removeEventListener('obelisk:run-started', onStarted);
      window.removeEventListener('obelisk:focus-run', onStarted);
    };
  }, [repo, upsertRun]);

  const agentLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.displayName);
    return m;
  }, [agents]);

  const planNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of planSummaries) m.set(p.id, p.name);
    return m;
  }, [planSummaries]);

  const repoRuns: Run[] = useMemo(() => {
    if (!repo) return [];
    return Object.values(runs).filter((r) => r.repoId === repo.id);
  }, [runs, repo]);

  const completedCount = useMemo(
    () => repoRuns.filter((r) => r.state === 'done' || r.state === 'failed').length,
    [repoRuns],
  );

  const handleDeleteRun = async (runId: string): Promise<void> => {
    const run = runs[runId];
    const label = run?.taskRef ? `"${run.taskRef}"` : 'this run';
    if (!confirm(`Delete ${label}? This removes the run, audit log, and saved evidence.`)) return;
    const res = await window.obelisk.invoke('runs:delete', { runId });
    if (res.ok) {
      removeRun(runId);
      if (selectedRunId === runId) {
        setSelectedRunId(null);
        setDrawerOpen(false);
      }
    } else {
      alert(`Couldn't delete run: ${res.error.message}`);
    }
  };

  const handleCancelRun = async (runId: string): Promise<void> => {
    // The orchestrator's bus broadcast updates the store on transition; we
    // don't need to optimistically mutate here. If the cancel IPC errors
    // (run already terminal, etc.), surface it inline.
    const res = await window.obelisk.invoke('agents:cancel', { runId });
    if (!res.ok) alert(`Couldn't stop run: ${res.error.message}`);
  };

  const handleClearCompleted = async (): Promise<void> => {
    if (!repo || completedCount === 0) return;
    if (
      !confirm(
        `Delete ${completedCount} completed run${completedCount === 1 ? '' : 's'} (done + failed) for this repo? Audit logs and evidence will be removed too.`,
      )
    ) {
      return;
    }
    const res = await window.obelisk.invoke('runs:deleteCompleted', {
      repoId: repo.id,
      states: ['done', 'failed'],
    });
    if (res.ok) {
      removeRunsByRepo(repo.id, ['done', 'failed']);
    } else {
      alert(`Couldn't clear runs: ${res.error.message}`);
    }
  };

  const selectedRun = selectedRunId ? (runs[selectedRunId] ?? null) : null;

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Mission Control shows live agent runs. Connect a repo to populate it."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }

  return (
    <div
      className={`mc${drawerOpen ? '' : ' drawer-closed'}`}
      onMouseDown={(e) => {
        if (!drawerOpen) return;
        const target = e.target as HTMLElement;
        // Don't close on drawer-internal clicks, on a card (which selects a
        // run and is meant to keep the drawer open), or on any button.
        if (target.closest('.mc-drawer, .mc-drawer-rail, .mc-card, button')) return;
        setDrawerOpen(false);
      }}
    >
      <div className="mc-pipeline-wrap">
        <div className="mc-toolbar">
          <div className="mc-toolbar-left">
            <div className="mc-toolbar-title">Mission Control</div>
            <span className="pill">{repoRuns.length} runs</span>
          </div>
          <div className="row gap-2">
            <button
              type="button"
              className="btn sm"
              onClick={async () => {
                const res = await window.obelisk.invoke('runs:list', {
                  repoId: repo.id,
                  limit: 100,
                });
                if (res.ok) {
                  for (const run of res.value) upsertRun(run);
                }
              }}
            >
              <Icon.Refresh size={11} /> Refresh
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={handleClearCompleted}
              disabled={completedCount === 0}
              title={
                completedCount === 0
                  ? 'No completed runs to clear'
                  : `Delete ${completedCount} completed run${completedCount === 1 ? '' : 's'}`
              }
            >
              <Icon.Trash size={11} /> Clear completed
              {completedCount > 0 ? ` (${completedCount})` : ''}
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={async () => {
                const res = await runAgentByName(repo.id, 'bug-fixer');
                if (res.ok) {
                  setSelectedRunId(res.value.runId);
                  setDrawerOpen(true);
                } else alert(res.error.message);
              }}
            >
              <Icon.Play size={11} /> Run Bug Fixer now
            </button>
          </div>
        </div>
        <div className="mc-pipeline">
          {STAGES.map((stage) => {
            const cards = repoRuns
              .filter((r) => stage.matchState.includes(r.state))
              .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
            return (
              <div key={stage.id} className="mc-stage">
                <div className="mc-stage-header">
                  <span className="dot" style={{ background: stage.color, color: stage.color }} />
                  <div>
                    <div className="mc-stage-name">{stage.label}</div>
                    <div className="mc-stage-sub">{stage.sub}</div>
                  </div>
                  <div className="mc-stage-count">{cards.length}</div>
                </div>
                <div className="mc-stage-body">
                  {cards.length === 0 ? (
                    <div className="mc-empty-stage">no runs</div>
                  ) : (
                    cards.map((run) => (
                      <RunCard
                        key={run.id}
                        run={run}
                        instanceName={run.agentId ? agentLabels.get(run.agentId) : undefined}
                        planNames={planNames}
                        stageColor={stage.color}
                        selected={run.id === selectedRunId}
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setDrawerOpen(true);
                        }}
                        onDelete={() => void handleDeleteRun(run.id)}
                        onCancel={() => void handleCancelRun(run.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {drawerOpen ? (
        <RunDrawer
          run={selectedRun}
          onClose={() => setSelectedRunId(null)}
          onToggle={() => setDrawerOpen(false)}
          onDelete={(id) => void handleDeleteRun(id)}
          onCancel={(id) => void handleCancelRun(id)}
        />
      ) : (
        <aside className="mc-drawer-rail">
          <button
            type="button"
            className="btn ghost icon"
            onClick={() => setDrawerOpen(true)}
            title="Show inspector"
            aria-pressed={false}
          >
            <Icon.PanelRight size={12} />
          </button>
        </aside>
      )}
    </div>
  );
}

function RunCard({
  run,
  instanceName,
  planNames,
  stageColor,
  selected,
  onClick,
  onDelete,
  onCancel,
}: {
  run: Run;
  instanceName?: string;
  planNames: Map<string, string>;
  stageColor: string;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onCancel: () => void;
}): ReactElement {
  const typeLabel = labelForAgent(run.agentName);
  const showInstance = instanceName && instanceName !== typeLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuOpen, menuRef, () => setMenuOpen(false));

  const isActive = run.state === 'queued' || run.state === 'running' || run.state === 'publishing';
  const canCancel = run.state === 'queued' || run.state === 'running';

  // A friendlier title than raw `plan:<id>` / `gh:<n>` task refs. Falls back
  // to the literal taskRef so unknown shapes still render usefully.
  const { title, subtitle } = describeTaskRef(run.taskRef, planNames);
  const timeLine = describeRunTime(run);
  const summaryLine = describeOutcome(run);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`mc-card${selected ? ' selected' : ''}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className="mc-card-accent" style={{ background: stageColor }} aria-hidden="true" />
      <div className="mc-card-head">
        <div className="mc-card-title-wrap">
          <div className="mc-card-title" title={run.taskRef ?? undefined}>
            {title}
          </div>
          {subtitle ? <div className="mc-card-subtitle">{subtitle}</div> : null}
        </div>
        <div ref={menuRef} className="mc-card-menu">
          <button
            type="button"
            className="btn ghost sm icon"
            aria-label="Card actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <Icon.More size={12} />
          </button>
          {menuOpen ? (
            <div role="menu" className="mc-card-menu-pop" onClick={(e) => e.stopPropagation()}>
              {canCancel ? (
                <button
                  type="button"
                  role="menuitem"
                  className="mc-card-menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onCancel();
                  }}
                >
                  <Icon.Pause size={11} /> Stop
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="mc-card-menu-item bad"
                disabled={isActive}
                title={isActive ? 'Stop the run before deleting' : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                <Icon.Trash size={11} /> Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mc-card-meta">
        <span
          className="pill"
          title={
            showInstance
              ? `Instance: ${instanceName} (type: ${typeLabel})`
              : `Agent type: ${typeLabel}`
          }
        >
          {instanceName ?? typeLabel}
        </span>
        {showInstance ? (
          <span className="pill" style={{ opacity: 0.7 }} title={`Agent type: ${typeLabel}`}>
            {typeLabel}
          </span>
        ) : null}
        <span className="pill" title={runnerHelp(run.runnerUsed)}>
          {run.runnerUsed}
        </span>
        {run.trigger !== 'manual' ? (
          <span className="pill" title={triggerHelp(run.trigger)}>
            {triggerLabel(run.trigger)}
          </span>
        ) : null}
        {run.fallbackUsed ? (
          <span className="pill warn" title={FALLBACK_HELP}>
            fallback
          </span>
        ) : null}
        {run.errorCode ? (
          <span className="pill bad" title={errorCodeHelp(run.errorCode)}>
            {run.errorCode}
          </span>
        ) : null}
      </div>
      {timeLine || summaryLine ? (
        <div className="mc-card-foot">
          {timeLine ? <span className="mc-card-time">{timeLine}</span> : null}
          {summaryLine ? (
            <span className="mc-card-summary" title={summaryLine}>
              {summaryLine}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function describeTaskRef(
  taskRef: string | null,
  planNames: Map<string, string>,
): { title: string; subtitle: string | null } {
  if (!taskRef) return { title: 'Ad-hoc run', subtitle: null };
  if (taskRef.startsWith('plan:')) {
    const planId = taskRef.slice('plan:'.length);
    const name = planNames.get(planId);
    if (name) return { title: name, subtitle: 'Test plan' };
    return { title: planId || 'Test plan', subtitle: 'Test plan (deleted)' };
  }
  if (taskRef.startsWith('gh:')) {
    const num = taskRef.slice('gh:'.length);
    return { title: `Issue #${num}`, subtitle: 'GitHub' };
  }
  if (taskRef.startsWith('manual:')) {
    return { title: taskRef.slice('manual:'.length) || 'Manual task', subtitle: 'Manual' };
  }
  return { title: taskRef, subtitle: null };
}

function describeRunTime(run: Run): string | null {
  if (run.state === 'queued' || (!run.startedAt && !run.finishedAt)) {
    return run.state === 'queued' ? 'Queued' : null;
  }
  if (run.finishedAt && run.startedAt) {
    const duration = humanizeDuration(
      new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
    );
    return `Ran ${duration} · ${humanizeAgo(run.finishedAt)}`;
  }
  if (run.startedAt) {
    return `Started ${humanizeAgo(run.startedAt)}`;
  }
  return null;
}

function describeOutcome(run: Run): string | null {
  if (run.state === 'failed' && run.errorCode) {
    return run.outputSummary ?? `Failed with ${run.errorCode}`;
  }
  if (run.state === 'cancelled') {
    return run.outputSummary ?? 'Stopped by the user';
  }
  if (run.state === 'done' && run.outputSummary) return run.outputSummary;
  return null;
}

function humanizeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

function triggerHelp(trigger: Run['trigger']): string {
  switch (trigger) {
    case 'manual':
      return 'You started this run from the app';
    case 'schedule':
      return 'The scheduler fired this run on its cron';
    case 'webhook':
      return 'A GitHub webhook fired this run';
    case 'cloud':
      return 'A cloud trigger fired this run';
    default:
      return `Trigger: ${trigger}`;
  }
}

function triggerLabel(trigger: Run['trigger']): string {
  switch (trigger) {
    case 'schedule':
      return 'scheduled';
    case 'webhook':
      return 'webhook';
    case 'cloud':
      return 'cloud';
    case 'manual':
      return 'you';
    default:
      return trigger;
  }
}

const FALLBACK_HELP =
  'The primary runner failed (crash, timeout, or non-zero exit). Obelisk retried with the other runner — this run finished on the fallback.';

function runnerHelp(name: string): string {
  if (name === 'claude') return 'Runner: Claude Code CLI (Anthropic)';
  if (name === 'codex') return 'Runner: Codex CLI (OpenAI)';
  return `Runner: ${name}`;
}

const ERROR_CODE_HELP: Partial<Record<ErrorCode, string>> = {
  INTERNAL: 'Unexpected error inside Obelisk. See the audit log for the underlying exception.',
  TIMEOUT: 'The run exceeded the agent’s timeout window.',
  RUNNER_NOT_INSTALLED: 'The CLI runner (claude or codex) is not on PATH. Install it and retry.',
  EVIDENCE_INCOMPLETE:
    'The agent did not produce the required evidence files (patch, tests, etc.).',
  REPRO_FAILED: 'The agent could not reproduce the reported issue.',
  PUSH_REJECTED: 'The branch push to GitHub was rejected.',
  TEST_LOOP_EXHAUSTED: 'Tests kept failing after the agent’s retry budget ran out.',
  SPEC_AMBIGUOUS: 'The task description was too vague for the agent to act on.',
  TEST_RUNNER_MISSING: 'No test runner detected in the repo (e.g. no package.json scripts).',
  ACTOR_NOT_ALLOWLISTED:
    'The GitHub actor that triggered this run is not on the per-repo allowlist.',
  AUTH_REQUIRED: 'GitHub auth is missing. Sign in from Settings.',
  AUTH_DENIED: 'GitHub denied the request — token may lack the needed scopes.',
  TOKEN_EXPIRED: 'GitHub token expired. Re-authenticate from Settings.',
  MODE_TOO_LOW:
    'The repo safety mode blocks this action (e.g. trying to open a PR while in Observe).',
  AGENT_BUSY: 'Another instance of this agent is already running for this repo.',
  RUN_ACTIVE: 'This run is still active and can’t be modified yet.',
};

function errorCodeHelp(code: string): string {
  return ERROR_CODE_HELP[code as ErrorCode] ?? `Error code: ${code}`;
}

function runStateHelp(state: RunState): string {
  switch (state) {
    case 'queued':
      return 'Queued — waiting for a free slot to start.';
    case 'running':
      return 'Running — the agent is reading code and producing evidence.';
    case 'publishing':
      return 'Publishing — packaging evidence and (if mode allows) opening an issue or PR.';
    case 'paused':
      return 'Paused — the run is waiting for a human action.';
    case 'done':
      return 'Done — the run completed successfully.';
    case 'failed':
      return 'Failed — see the error code and audit log.';
    case 'cancelled':
      return 'Cancelled — you stopped this run.';
  }
}

type Tab = 'plan' | 'findings' | 'audit' | 'evidence' | 'reasoning' | 'files';

function RunDrawer({
  run,
  onClose,
  onToggle,
  onDelete,
  onCancel,
}: {
  run: Run | null;
  onClose: () => void;
  onToggle: () => void;
  onDelete: (runId: string) => void;
  onCancel: (runId: string) => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('audit');
  const [details, setDetails] = useState<{
    auditLog: AuditLine[];
    evidence: EvidenceItem[];
  } | null>(null);
  const [findings, setFindings] = useState<PreviewedFinding[]>([]);
  const [modalFinding, setModalFinding] = useState<PreviewedFinding | null>(null);
  const [plan, setPlan] = useState<TestPlan | null>(null);

  const refreshFindings = useCallback(async (runId: string, repoId: string) => {
    const res = await window.obelisk.invoke('previews:list', { repoId });
    if (!res.ok) return;
    setFindings(res.value.findings.filter((f) => f.runId === runId));
  }, []);

  const refreshDetails = useCallback(async (runId: string) => {
    const res = await window.obelisk.invoke('runs:get', { runId });
    if (res.ok) setDetails({ auditLog: res.value.auditLog, evidence: res.value.evidence });
  }, []);

  useEffect(() => {
    if (!run) {
      setDetails(null);
      setFindings([]);
      setPlan(null);
      return;
    }
    void refreshDetails(run.id);
    void refreshFindings(run.id, run.repoId);
    // If this run is plan-driven (taskRef = "plan:<id>"), load the plan so
    // the Plan Progress tab can render the grid.
    const planId = parsePlanIdFromTaskRef(run.taskRef);
    if (planId) {
      void window.obelisk
        .invoke('testPlans:get', { planId, repoId: run.repoId })
        .then((res) => setPlan(res.ok ? res.value : null));
    } else {
      setPlan(null);
    }
  }, [run, refreshFindings, refreshDetails]);

  useEffect(() => {
    if (!run) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'previews.changed' && evt.repoId === run.repoId) {
        void refreshFindings(run.id, run.repoId);
        return;
      }
      // Live audit + case-progress streaming — refetch on every event for
      // this run so the Plan Progress tab updates as CASE_PASS/FAIL fire.
      // Cheap (single SQLite read), and we only refetch when the event
      // matches this run.
      if (
        (evt.type === 'run.audit' && evt.runId === run.id) ||
        (evt.type === 'run.caseProgress' && evt.runId === run.id) ||
        (evt.type === 'run.transition' && evt.runId === run.id)
      ) {
        void refreshDetails(run.id);
      }
    });
  }, [run, refreshFindings, refreshDetails]);

  const hasFindings = findings.filter((f) => !f.dismissed).length > 0;
  const isTerminal = run?.state === 'done' || run?.state === 'failed' || run?.state === 'cancelled';
  const tabSetForRun = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    if (tabSetForRun.current === run.id) return;
    tabSetForRun.current = run.id;
    // Failed runs go straight to audit so the stderr/stdout of the broken
    // CLI invocation is the first thing the user sees — no clicking around
    // a "plan" tab to find the diagnostic. For other states, prefer:
    //   Plan > Findings (if terminal) > Audit.
    if (run.state === 'failed') setTab('audit');
    else if (plan) setTab('plan');
    else if (hasFindings && isTerminal) setTab('findings');
    else setTab('audit');
  }, [run, plan, hasFindings, isTerminal]);

  async function dismissFinding(f: PreviewedFinding): Promise<void> {
    const res = await window.obelisk.invoke('previews:dismiss', { previewId: f.id });
    if (!res.ok) alert(res.error.message);
  }

  const toggleBtn = (
    <button
      type="button"
      className="btn ghost icon"
      onClick={onToggle}
      title="Hide inspector"
      aria-pressed={true}
    >
      <Icon.PanelRight size={12} />
    </button>
  );

  if (!run) {
    return (
      <aside className="mc-drawer">
        <div className="mc-drawer-toolbar">{toggleBtn}</div>
        <div className="mc-drawer-empty">Pick a run to inspect.</div>
      </aside>
    );
  }

  const isActive = run.state === 'queued' || run.state === 'running' || run.state === 'publishing';
  const canCancel = run.state === 'queued' || run.state === 'running';

  return (
    <aside className="mc-drawer">
      <div className="mc-drawer-toolbar">
        <button
          type="button"
          className="btn ghost icon"
          onClick={() => onDelete(run.id)}
          disabled={isActive}
          title={isActive ? 'Stop the run before deleting' : 'Delete this run and its evidence'}
        >
          <Icon.Trash size={11} />
        </button>
        {canCancel ? (
          <button
            type="button"
            className="btn ghost sm mc-drawer-stop"
            onClick={() => onCancel(run.id)}
            title="Stop this run"
            data-testid="mc-drawer-stop"
          >
            <Icon.Pause size={11} /> Stop
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost icon" onClick={onClose} title="Deselect">
          <Icon.Close size={11} />
        </button>
        {toggleBtn}
      </div>
      <div className="mc-drawer-header">
        <div className="mc-drawer-title">{run.taskRef ?? '(no task ref)'}</div>
        <div className="mc-drawer-meta">
          <span className="pill" title={`Agent type: ${labelForAgent(run.agentName)}`}>
            {labelForAgent(run.agentName)}
          </span>
          <span className="pill" title={runnerHelp(run.runnerUsed)}>
            {run.runnerUsed}
          </span>
          <span className="pill" title={runStateHelp(run.state)}>
            {run.state}
          </span>
          {run.fallbackUsed ? (
            <span className="pill warn" title={FALLBACK_HELP}>
              fallback
            </span>
          ) : null}
          {run.errorCode ? (
            <span className="pill bad" title={errorCodeHelp(run.errorCode)}>
              {run.errorCode}
            </span>
          ) : null}
        </div>
        {run.outputSummary ? <div className="mc-drawer-summary">{run.outputSummary}</div> : null}
        {run.errorCode === 'RUNNER_LOGIN_REQUIRED' ? (
          <RunnerLoginActionCard
            runner={run.runnerUsed}
            onRetry={
              run.agentId
                ? () => {
                    const taskId = run.taskRef ?? undefined;
                    void window.obelisk
                      .invoke('agents:run', {
                        agentId: run.agentId!,
                        ...(taskId ? { taskId } : {}),
                      })
                      .then((res) => {
                        if (!res.ok) alert(`Couldn't retry: ${res.error.message}`);
                      });
                  }
                : undefined
            }
          />
        ) : null}
      </div>
      <div className="mc-tabs">
        {[
          ...(plan ? (['plan'] as Tab[]) : []),
          ...(hasFindings ? (['findings'] as Tab[]) : []),
          ...(['audit', 'evidence', 'reasoning', 'files'] as Tab[]),
        ].map((t) => (
          <button
            key={t}
            type="button"
            className={`mc-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'findings'
              ? `findings (${findings.filter((f) => !f.dismissed).length})`
              : t === 'plan' && plan
                ? `plan (${plan.caseCount})`
                : t}
          </button>
        ))}
      </div>
      <div className="mc-tab-body">
        {tab === 'plan' && plan && (
          <PlanProgressTab
            plan={plan}
            auditLog={details?.auditLog ?? []}
            findings={findings}
            runState={run.state}
          />
        )}
        {tab === 'findings' && (
          <FindingsTab findings={findings} onOpen={setModalFinding} onDismiss={dismissFinding} />
        )}
        {tab === 'audit' && <AuditTab lines={details?.auditLog ?? []} runState={run.state} />}
        {tab === 'evidence' && <EvidenceTab evidence={details?.evidence ?? []} />}
        {tab === 'reasoning' && <ReasoningTab lines={details?.auditLog ?? []} />}
        {tab === 'files' && <FilesTab evidence={details?.evidence ?? []} />}
      </div>
      <FileIssueModal
        open={modalFinding !== null}
        finding={modalFinding}
        onClose={() => setModalFinding(null)}
        onFiled={() => {
          // Bus broadcast triggers refresh.
        }}
      />
    </aside>
  );
}

/**
 * "Plan" tab — live test-suite view. For each case in the assigned plan,
 * render a row with its current state derived from:
 *   1. The latest `case_progress` audit row matching this case_id.
 *   2. If terminal-state and a finding mentions this case_id → 'failed'.
 *   3. If terminal-state and no marker / no finding → 'passed' (the agent
 *      finished without flagging this case).
 *   4. If the run was cancelled before reaching the case → 'skipped'.
 *   5. Otherwise → 'queued'.
 *
 * Live: the parent subscribes to bus events and refreshes details, so this
 * component repaints as markers stream in.
 */
function PlanProgressTab({
  plan,
  auditLog,
  findings,
  runState,
}: {
  plan: TestPlan;
  auditLog: AuditLine[];
  findings: PreviewedFinding[];
  runState: RunState;
}): ReactElement {
  const stateByCase = derivePerCaseState({ plan, auditLog, findings, runState });

  const counts = countByState(stateByCase);
  const total = plan.caseCount;
  const groups = groupBlocks(plan);

  return (
    <div className="mc-plan">
      <header className="mc-plan-summary">
        <div className="mc-plan-summary-title">{plan.frontmatter.name}</div>
        <div className="mc-plan-summary-counts">
          <CaseStatePill state="passed" count={counts.passed} />
          <CaseStatePill state="failed" count={counts.failed} />
          <CaseStatePill state="running" count={counts.running} />
          <CaseStatePill state="inconclusive" count={counts.inconclusive} />
          <CaseStatePill state="queued" count={counts.queued} />
          <CaseStatePill state="skipped" count={counts.skipped} />
        </div>
        <div className="mc-plan-progress-bar">
          <div
            className="mc-plan-progress-fill"
            style={{
              width: `${total === 0 ? 0 : Math.round(((counts.passed + counts.failed + counts.inconclusive + counts.skipped) / total) * 100)}%`,
            }}
          />
        </div>
      </header>

      <div className="mc-plan-body">
        {groups.map((g) => (
          <section className="mc-plan-section" key={g.section?.id ?? `unsec-${g.cases[0]?.id}`}>
            {g.section ? (
              <div className="mc-plan-section-head">
                <div className="mc-plan-section-title">{g.section.title}</div>
                <div className="mc-plan-section-count">
                  {g.cases.length} case{g.cases.length === 1 ? '' : 's'}
                </div>
              </div>
            ) : null}
            <ol className="mc-plan-cases">
              {g.cases.map((c) => {
                const state = stateByCase.get(c.id) ?? 'queued';
                return (
                  <li key={c.id} className={`mc-plan-case mc-plan-case-${state}`}>
                    <CaseStateIcon state={state} />
                    {c.severity ? (
                      <span className={`pill sev-${c.severity.toLowerCase()}`}>{c.severity}</span>
                    ) : (
                      <span className="mc-plan-case-sev-spacer" aria-hidden="true" />
                    )}
                    <div className="mc-plan-case-body">
                      <div className="mc-plan-case-title">{c.title}</div>
                      {c.expected ? (
                        <div className="mc-plan-case-meta">
                          <span className="mc-plan-case-meta-key">Expected:</span> {c.expected}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

const CASE_STATE_LABEL: Record<CaseProgressState, string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Pass',
  failed: 'Fail',
  inconclusive: 'Inconclusive',
  skipped: 'Skipped',
};

function CaseStatePill({
  state,
  count,
}: {
  state: CaseProgressState;
  count: number;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <span className={`mc-plan-pill mc-plan-pill-${state}`}>
      {count} {CASE_STATE_LABEL[state]}
    </span>
  );
}

function CaseStateIcon({ state }: { state: CaseProgressState }): ReactElement {
  if (state === 'running') {
    return (
      <span className="mc-plan-case-icon" aria-label="Running">
        <Icon.Spinner size={12} style={{ animation: 'spin 1s linear infinite' }} />
      </span>
    );
  }
  if (state === 'passed') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-passed" aria-label="Passed">
        <Icon.Check size={12} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-failed" aria-label="Failed">
        <Icon.AlertTri size={12} />
      </span>
    );
  }
  if (state === 'inconclusive') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-inconclusive" aria-label="Inconclusive">
        <Icon.Help size={12} />
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-skipped" aria-label="Skipped">
        <Icon.Close size={12} />
      </span>
    );
  }
  return (
    <span className="mc-plan-case-icon mc-plan-case-icon-queued" aria-label="Queued">
      <Icon.Dot size={10} />
    </span>
  );
}

interface PlanGroup {
  section: { id: string; title: string } | null;
  cases: {
    id: string;
    title: string;
    expected: string | null;
    severity: 'P0' | 'P1' | 'P2' | null;
  }[];
}

function groupBlocks(plan: TestPlan): PlanGroup[] {
  const groups: PlanGroup[] = [];
  let current: PlanGroup | null = null;
  for (const b of plan.blocks) {
    if (b.kind === 'section') {
      current = { section: { id: b.id, title: b.title }, cases: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { section: null, cases: [] };
        groups.push(current);
      }
      current.cases.push({
        id: b.id,
        title: b.title,
        expected: b.expected,
        severity: b.severity,
      });
    }
  }
  return groups;
}

function parsePlanIdFromTaskRef(taskRef: string | null): string | null {
  if (!taskRef) return null;
  return taskRef.startsWith('plan:') ? taskRef.slice('plan:'.length) : null;
}

function FindingsTab({
  findings,
  onOpen,
  onDismiss,
}: {
  findings: PreviewedFinding[];
  onOpen: (f: PreviewedFinding) => void;
  onDismiss: (f: PreviewedFinding) => void;
}): ReactElement {
  const visible = findings.filter((f) => !f.dismissed);
  if (visible.length === 0) return <Empty>No findings to review.</Empty>;
  return (
    <div className="mc-findings col gap-1">
      {visible.map((f) => (
        <FindingPreview key={f.id} finding={f} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function AuditTab({ lines, runState }: { lines: AuditLine[]; runState: RunState }): ReactElement {
  const isLive = runState === 'queued' || runState === 'running' || runState === 'publishing';
  // Newest-first ordering. New events land at row 1 — no scrolling needed
  // to see "what just happened", which is the question users open this tab
  // to answer. Chronological order pushed the latest line off-screen as a
  // run streamed and required auto-scroll to compensate; reverse-chrono is
  // also the right default for terminal runs because the result/error/
  // final state is the most-relevant line and lands on top.
  const ordered = useMemo(() => [...lines].reverse(), [lines]);

  return (
    <div className="mc-audit-wrap">
      <div className="mc-audit-header">
        {isLive ? <LivePill /> : <span className="mc-audit-status-idle">Settled</span>}
        <span className="mc-audit-count">
          {lines.length} {lines.length === 1 ? 'entry' : 'entries'}
        </span>
        <span className="mc-audit-order" title="Most recent at the top">
          newest first
        </span>
      </div>
      {lines.length === 0 ? (
        <Empty>{isLive ? 'Waiting for the runner’s first output…' : 'No audit entries yet.'}</Empty>
      ) : (
        <div className="col gap-1">
          {ordered.map((l) => (
            <div key={l.id} className="mc-audit-row">
              <span className="mc-audit-time">{shortTime(l.at)}</span>
              <span className="mc-audit-kind">{l.kind}</span>
              <div className="mc-audit-msg">{describePayload(l.payload)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LivePill(): ReactElement {
  return (
    <span className="mc-audit-live" title="Streaming — new entries appear as they arrive">
      <span className="mc-audit-live-dot" aria-hidden="true" />
      Live
    </span>
  );
}

function EvidenceTab({ evidence }: { evidence: EvidenceItem[] }): ReactElement {
  if (evidence.length === 0) return <Empty>No evidence captured yet.</Empty>;
  const groups: Record<string, EvidenceItem[]> = {};
  for (const e of evidence) {
    (groups[e.kind] ??= []).push(e);
  }
  return (
    <div>
      {Object.entries(groups).map(([kind, items]) => (
        <div key={kind} className="mc-evidence-section">
          <div className="mc-evidence-section-title">{kind}</div>
          <ul className="mc-evidence-list">
            {items.map((it) => (
              <li key={it.path}>
                {basename(it.path)} · {it.bytes}b · sha:{it.sha256.slice(0, 10)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ReasoningTab({ lines }: { lines: AuditLine[] }): ReactElement {
  const reasoningLines = lines.filter((l) => l.kind === 'reasoning' || l.kind === 'evidence_check');
  if (reasoningLines.length === 0) return <Empty>No reasoning entries yet.</Empty>;
  return (
    <div className="col gap-2">
      {reasoningLines.map((l) => (
        <div key={l.id}>
          <div className="mc-evidence-section-title">{l.kind}</div>
          <pre className="mc-pre-payload">{JSON.stringify(l.payload, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

function FilesTab({ evidence }: { evidence: EvidenceItem[] }): ReactElement {
  const patches = evidence.filter((e) => e.kind === 'patch' || e.kind === 'failing_test_diff');
  if (patches.length === 0) return <Empty>No patch artifacts yet.</Empty>;
  return (
    <ul className="mc-files-list">
      {patches.map((p) => (
        <li key={p.path}>
          {basename(p.path)} ({p.bytes} bytes)
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="mc-empty">{children}</div>;
}

function describePayload(payload: unknown): ReactNode {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  return <pre className="mc-pre-payload">{JSON.stringify(payload, null, 2)}</pre>;
}

function shortTime(iso: string): string {
  // HH:MM:SS in local time.
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return iso;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
