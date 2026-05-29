import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import { useClickOutside } from '../hooks/useClickOutside';
import { EmptyState } from '../ui/EmptyState';
import { RemoveRunDialog, type RemoveAction } from '../components/RemoveRunDialog';
import { showApiAlert } from '../state/alert-store';
import { showConfirm } from '../state/confirm-store';
import { RunnerLoginActionCard } from '../components/RunnerLoginActionCard';
import { SpecClarificationModal } from '../components/SpecClarificationModal';
import { RunInspector } from '../components/RunInspector';
import { retryRun } from '../lib/retry-run';
import { labelForAgent, humanizeAgo, humanizeDuration } from '../format';
import type { Agent, Run, RunState, TestPlan, TestPlanSummary } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { parsePlanIdFromTaskRef } from '../../shared/task-refs';
import {
  countByState,
  derivePerCaseState,
  formatCardCounts,
  type PlanCardCounts,
} from './mission-control-helpers';

// Re-export so test files importing from this module path keep working.
export { parsePlanIdFromTaskRef };

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

  const [planCounts, setPlanCounts] = useState<Map<string, PlanCardCounts>>(new Map());
  const planCache = useRef<Map<string, TestPlan | null>>(new Map());

  const fetchPlanCountsForRun = useCallback(async (run: Run): Promise<void> => {
    const planId = parsePlanIdFromTaskRef(run.taskRef);
    if (!planId) return;
    // Kick both fetches in parallel — they're independent: testPlans:get
    // only needs planId, runs:get only needs runId. Cached plans skip
    // the testPlans:get round-trip entirely.
    const cachedPlan = planCache.current.get(planId);
    const planPromise =
      cachedPlan !== undefined
        ? Promise.resolve(cachedPlan)
        : window.obelisk.invoke('testPlans:get', { planId, repoId: run.repoId }).then((res) => {
            const p = res.ok ? res.value : null;
            planCache.current.set(planId, p);
            return p;
          });
    const runPromise = window.obelisk.invoke('runs:get', { runId: run.id });
    const [plan, runRes] = await Promise.all([planPromise, runPromise]);
    if (!plan || !runRes.ok) return;
    const { byCase, untracked } = derivePerCaseState({
      plan,
      auditLog: runRes.value.auditLog,
      findings: [],
      runState: run.state,
    });
    const c = countByState(byCase);
    setPlanCounts((prev) => {
      const next = new Map(prev);
      next.set(run.id, {
        passed: c.passed,
        failed: c.failed,
        skipped: c.skipped,
        inconclusive: c.inconclusive,
        untracked: untracked.length,
      });
      return next;
    });
  }, []);

  useEffect(() => {
    for (const run of repoRuns) {
      if (!parsePlanIdFromTaskRef(run.taskRef)) continue;
      if (run.state !== 'done' && run.state !== 'failed' && run.state !== 'cancelled') continue;
      if (planCounts.has(run.id)) continue;
      void fetchPlanCountsForRun(run);
    }
  }, [repoRuns, planCounts, fetchPlanCountsForRun]);

  // Refetch on terminal transition. Reads `runs` via store.getState() so
  // this effect doesn't re-subscribe on every audit-tick re-render — the
  // subscription is registered once per repo change.
  useEffect(() => {
    if (!repo) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type !== 'run.transition') return;
      if (evt.state !== 'done' && evt.state !== 'failed' && evt.state !== 'cancelled') return;
      const run = useStore.getState().runs[evt.runId];
      if (!run || run.repoId !== repo.id) return;
      if (!parsePlanIdFromTaskRef(run.taskRef)) return;
      void fetchPlanCountsForRun(run);
    });
  }, [repo, fetchPlanCountsForRun]);

  const completedCount = useMemo(
    () => repoRuns.filter((r) => r.state === 'done' || r.state === 'failed').length,
    [repoRuns],
  );

  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [removeTarget, setRemoveTarget] = useState<{ runId: string; label: string } | null>(null);
  const [clarifyRun, setClarifyRun] = useState<Run | null>(null);
  const [archivedCount, setArchivedCount] = useState<number>(0);

  const refreshArchivedCount = useCallback(async () => {
    if (!repo) {
      setArchivedCount(0);
      return;
    }
    const res = await window.obelisk.invoke('archive:count', { repoId: repo.id });
    if (res.ok) setArchivedCount(res.value.count);
  }, [repo]);

  useEffect(() => {
    void refreshArchivedCount();
    const handler = (): void => {
      void refreshArchivedCount();
    };
    window.addEventListener('obelisk:archive-changed', handler);
    return () => window.removeEventListener('obelisk:archive-changed', handler);
  }, [refreshArchivedCount]);

  // Perform the actual removal once we know which action to take (silent path
  // when the user has set a preference, or after the dialog confirms).
  const performRemove = useCallback(
    async (runId: string, action: RemoveAction): Promise<void> => {
      const channel = action === 'archive' ? 'runs:archive' : 'runs:delete';
      const res = await window.obelisk.invoke(channel, { runId });
      if (res.ok) {
        removeRun(runId);
        setPlanCounts((prev) => {
          if (!prev.has(runId)) return prev;
          const next = new Map(prev);
          next.delete(runId);
          return next;
        });
        if (selectedRunId === runId) {
          setSelectedRunId(null);
          setDrawerOpen(false);
        }
        if (action === 'archive') void refreshArchivedCount();
      } else {
        showApiAlert(res.error, action === 'archive' ? 'archive run' : 'delete run');
      }
    },
    [removeRun, selectedRunId, refreshArchivedCount],
  );

  const handleDeleteRun = async (runId: string): Promise<void> => {
    const run = runs[runId];
    const label = run?.taskContext?.trim() || run?.taskRef || 'this run';
    const pref = settings?.cardRemoveAction ?? 'ask';
    if (pref === 'archive' || pref === 'delete') {
      await performRemove(runId, pref);
      return;
    }
    setRemoveTarget({ runId, label });
  };

  const handleCancelRun = async (runId: string): Promise<void> => {
    // The orchestrator's bus broadcast updates the store on transition; we
    // don't need to optimistically mutate here. If the cancel IPC errors
    // (run already terminal, etc.), surface it inline.
    const res = await window.obelisk.invoke('agents:cancel', { runId });
    if (!res.ok) showApiAlert(res.error, 'stop run');
  };

  const handleRetryRun = async (runId: string): Promise<void> => {
    const run = runs[runId];
    if (!run) return;
    // A run that paused for spec clarification (REPRO_FAILED) must not be
    // blindly re-dispatched — it would hit the same wall. Open the modal to
    // collect the missing repro/spec; the modal threads it into the retry.
    if (run.errorCode === 'REPRO_FAILED') {
      setClarifyRun(run);
      return;
    }
    // Normal retry: re-run the same task and surface the run-started toast so
    // the user gets feedback (the new run also arrives via the bus broadcast).
    const res = await retryRun(run);
    if (!res.ok) showApiAlert(res.error, 'retry run');
  };

  const handleClearCompleted = async (): Promise<void> => {
    if (!repo || completedCount === 0) return;
    const ok = await showConfirm({
      title: `Move ${completedCount} completed run${completedCount === 1 ? '' : 's'} to the archive?`,
      body: 'You can search, restore, or delete them permanently from the archive.',
      confirmLabel: 'Archive',
      confirmIcon: 'Archive',
    });
    if (!ok) return;
    const res = await window.obelisk.invoke('runs:archiveCompleted', {
      repoId: repo.id,
      states: ['done', 'failed'],
    });
    if (res.ok) {
      const archivedIds = new Set(
        repoRuns.filter((r) => r.state === 'done' || r.state === 'failed').map((r) => r.id),
      );
      removeRunsByRepo(repo.id, ['done', 'failed']);
      setPlanCounts((prev) => {
        let mutated = false;
        const next = new Map(prev);
        for (const id of archivedIds) {
          if (next.delete(id)) mutated = true;
        }
        return mutated ? next : prev;
      });
      setArchivedCount(res.value.total);
    } else {
      showApiAlert(res.error, 'archive runs');
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
              onClick={() => useStore.getState().setRoute('archive')}
              title={
                archivedCount === 0
                  ? 'Open archive (empty)'
                  : `Open archive (${archivedCount} run${archivedCount === 1 ? '' : 's'})`
              }
            >
              <Icon.Archive size={11} /> Archive
              {archivedCount > 0 ? ` (${archivedCount})` : ''}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={handleClearCompleted}
              disabled={completedCount === 0}
              title={
                completedCount === 0
                  ? 'No completed runs to archive'
                  : `Move ${completedCount} completed run${completedCount === 1 ? '' : 's'} to the archive`
              }
            >
              <Icon.Archive size={11} /> Archive completed
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
                } else {
                  showApiAlert(res.error, 'start run');
                }
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
                        repoFullName={repo?.githubFullName ?? null}
                        stageColor={stage.color}
                        selected={run.id === selectedRunId}
                        planCounts={planCounts.get(run.id) ?? null}
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setDrawerOpen(true);
                        }}
                        onDelete={() => void handleDeleteRun(run.id)}
                        onCancel={() => void handleCancelRun(run.id)}
                        onRetry={() => void handleRetryRun(run.id)}
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
          planNames={planNames}
          onClose={() => setSelectedRunId(null)}
          onToggle={() => setDrawerOpen(false)}
          onDelete={(id) => void handleDeleteRun(id)}
          onCancel={(id) => void handleCancelRun(id)}
          onRetry={(id) => void handleRetryRun(id)}
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
      <RemoveRunDialog
        open={removeTarget !== null}
        runLabel={removeTarget?.label ?? ''}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={async (choice, remember) => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          if (remember) {
            const res = await window.obelisk.invoke('settings:update', {
              cardRemoveAction: choice,
            });
            if (res.ok) setSettings(res.value);
          }
          await performRemove(target.runId, choice);
        }}
      />
      <SpecClarificationModal
        open={clarifyRun !== null}
        run={clarifyRun}
        onClose={() => setClarifyRun(null)}
        onRetried={() => setClarifyRun(null)}
      />
    </div>
  );
}

function RunCard({
  run,
  instanceName,
  planNames,
  repoFullName,
  stageColor,
  selected,
  planCounts,
  onClick,
  onDelete,
  onCancel,
  onRetry,
}: {
  run: Run;
  instanceName?: string;
  planNames: Map<string, string>;
  repoFullName: string | null;
  stageColor: string;
  selected: boolean;
  planCounts: PlanCardCounts | null;
  onClick: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onRetry: () => void;
}): ReactElement {
  const typeLabel = labelForAgent(run.agentName);
  const showInstance = instanceName && instanceName !== typeLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuOpen, menuRef, () => setMenuOpen(false));

  const isActive = run.state === 'queued' || run.state === 'running' || run.state === 'publishing';
  const canCancel = run.state === 'queued' || run.state === 'running';
  // Retry re-runs the same task; only meaningful once the run has settled and
  // is linked to an agent instance with a task ref.
  const canRetry = !isActive && run.agentId !== null && run.taskRef !== null;

  // A friendlier title than raw `plan:<id>` / `issue#<n>` / `backlog#<id>`
  // task refs. Pulls in the snapshotted task_context so the user sees the
  // GitHub issue title (or manual backlog title) the agent claimed.
  const { title, subtitle, issueHref } = describeTaskRef(
    run.taskRef,
    run.taskContext,
    planNames,
    repoFullName,
  );
  const timeLine = describeRunTime(run);
  const summaryLine = describeOutcome(run);
  const cardCounts = formatCardCounts(planCounts);

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
          {subtitle ? (
            <div className="mc-card-subtitle">
              {issueHref ? (
                <a
                  href={issueHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid={`mc-card-issue-link-${run.id}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {subtitle}
                </a>
              ) : (
                subtitle
              )}
            </div>
          ) : null}
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
              {canRetry ? (
                <button
                  type="button"
                  role="menuitem"
                  className="mc-card-menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onRetry();
                  }}
                >
                  <Icon.Refresh size={11} /> Retry
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
      {cardCounts ? (
        <div className="mc-card-counts" title={cardCounts.text}>
          {cardCounts.pills.map((p) => (
            <span key={p.state} className={`mc-card-count-pill mc-card-count-pill-${p.state}`}>
              {p.label}
            </span>
          ))}
        </div>
      ) : null}
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

export function describeTaskRef(
  taskRef: string | null,
  taskContext: string | null,
  planNames: Map<string, string>,
  repoFullName: string | null,
): { title: string; subtitle: string | null; issueHref: string | null } {
  if (!taskRef) return { title: 'Ad-hoc run', subtitle: null, issueHref: null };
  if (taskRef.startsWith('plan:')) {
    const planId = taskRef.slice('plan:'.length);
    const name = planNames.get(planId);
    if (name) return { title: name, subtitle: 'Test plan', issueHref: null };
    return { title: planId || 'Test plan', subtitle: 'Test plan (deleted)', issueHref: null };
  }
  // Bug Fixer / Feature Builder claim refs: `issue#<n>` for GitHub-backed
  // backlog rows, `backlog#<id>` for manual rows.
  if (taskRef.startsWith('issue#')) {
    const num = taskRef.slice('issue#'.length);
    const title = taskContext?.trim() ? taskContext.trim() : `Issue #${num}`;
    const href =
      repoFullName && /^[\w.-]+\/[\w.-]+$/.test(repoFullName)
        ? `https://github.com/${repoFullName}/issues/${num}`
        : null;
    return { title, subtitle: `GitHub issue #${num}`, issueHref: href };
  }
  // PR Reviewer claim refs: `pr#<n>@<short-sha>` (the sha is provenance only).
  if (taskRef.startsWith('pr#')) {
    const num = taskRef.slice('pr#'.length).split('@')[0];
    // task_context is "Reviewing/Fixing PR #<n>: <title>" — strip the
    // verb+number prefix so the card shows just the descriptive PR title,
    // matching the issue# card (which shows the bare issue title).
    const ctx = taskContext?.trim() ?? '';
    const stripped = ctx.replace(/^(?:Reviewing|Fixing) PR #\d+:\s*/, '').trim();
    const title = stripped || `PR #${num}`;
    const href =
      repoFullName && /^[\w.-]+\/[\w.-]+$/.test(repoFullName)
        ? `https://github.com/${repoFullName}/pull/${num}`
        : null;
    return { title, subtitle: `GitHub PR #${num}`, issueHref: href };
  }
  if (taskRef.startsWith('backlog#')) {
    const title = taskContext?.trim() ? taskContext.trim() : 'Manual backlog item';
    return { title, subtitle: 'Manual backlog', issueHref: null };
  }
  // Legacy shape kept for old run rows.
  if (taskRef.startsWith('gh:')) {
    const num = taskRef.slice('gh:'.length);
    return { title: `Issue #${num}`, subtitle: 'GitHub', issueHref: null };
  }
  if (taskRef.startsWith('manual:')) {
    return {
      title: taskRef.slice('manual:'.length) || 'Manual task',
      subtitle: 'Manual',
      issueHref: null,
    };
  }
  return { title: taskRef, subtitle: null, issueHref: null };
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
  REPRO_FAILED:
    'The agent couldn’t confirm the reported bug and paused for your input. Add the missing repro steps or spec, then retry.',
  NO_CHANGES:
    'The agent investigated but produced no code change. Open the Activity tab to see what it found, then refine the issue or retry.',
  PUSH_REJECTED:
    'GitHub rejected the branch push (e.g. a protected-branch or pre-receive/LFS hook). See the message in the summary.',
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
  BACKLOG_EMPTY:
    'No issues with the `obelisk:fix` (bug-fixer) or `obelisk:feature` (feature-builder) label. Apply one to a GitHub issue, or add a manual backlog item.',
  BACKLOG_ALL_FILTERED:
    'Every candidate issue was filtered out (closed, locked, claimed elsewhere, or not on the actor allowlist).',
  NO_OPEN_PRS: 'There are no open pull requests in this repo for PR Reviewer to review.',
  PRS_ALL_FILTERED:
    'Every open PR was skipped (already reviewed at its latest commit, not on the actor allowlist, claimed elsewhere, or past the failed-review cap).',
  WORKTREE_BUSY:
    'The PR branch is still checked out by another live run. Wait for it to finish, then retry.',
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
      return 'Failed — see the error code and activity timeline.';
    case 'cancelled':
      return 'Cancelled — you stopped this run.';
  }
}

function RunDrawer({
  run,
  planNames,
  onClose,
  onToggle,
  onDelete,
  onCancel,
  onRetry,
}: {
  run: Run | null;
  planNames: Map<string, string>;
  onClose: () => void;
  onToggle: () => void;
  onDelete: (runId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
}): ReactElement {
  const repos = useStore((s) => s.repos);
  const repoFullName = useMemo(() => {
    if (!run) return null;
    return repos.find((r) => r.id === run.repoId)?.githubFullName ?? null;
  }, [run, repos]);
  // Match the run card's title: the descriptive issue/PR/plan title from
  // taskContext, not the raw `issue#52` ref. Falls back to the ref when there's
  // no context to describe.
  const drawerDesc = useMemo(
    () =>
      run
        ? describeTaskRef(run.taskRef, run.taskContext, planNames, repoFullName)
        : { title: '', subtitle: null, issueHref: null },
    [run, planNames, repoFullName],
  );

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
  const canRetry = !isActive && run.agentId !== null && run.taskRef !== null;

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
        {canRetry ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onRetry(run.id)}
            title="Re-run this run against the same task"
            data-testid="mc-drawer-retry"
          >
            <Icon.Refresh size={11} /> Retry
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost icon" onClick={onClose} title="Deselect">
          <Icon.Close size={11} />
        </button>
        {toggleBtn}
      </div>
      <div className="mc-drawer-header">
        <div className="mc-drawer-title" title={run.taskRef ?? undefined}>
          {drawerDesc.title}
        </div>
        {drawerDesc.subtitle ? (
          <div className="mc-drawer-subtitle">{drawerDesc.subtitle}</div>
        ) : null}
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
            onRetry={canRetry ? () => onRetry(run.id) : undefined}
          />
        ) : null}
        {run.errorCode === 'REPRO_FAILED' ? (
          <div className="mc-needs-spec-card" role="alert">
            <div className="mc-needs-spec-icon" aria-hidden="true">
              <Icon.Help size={14} />
            </div>
            <div className="mc-needs-spec-body">
              <div className="mc-needs-spec-title">The agent needs your input</div>
              <div className="mc-needs-spec-text">
                {labelForAgent(run.agentName)} investigated this issue but couldn’t confirm the bug.
                Add the missing repro steps or spec and it’ll try again.
              </div>
              <button
                type="button"
                className="btn primary sm"
                onClick={() => onRetry(run.id)}
                data-testid="mc-needs-spec-clarify"
              >
                <Icon.Refresh size={11} /> Provide details &amp; retry
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <RunInspector run={run} repoFullName={repoFullName} />
    </aside>
  );
}
