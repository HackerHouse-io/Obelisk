import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import { useClickOutside } from '../hooks/useClickOutside';
import { EmptyState } from '../ui/EmptyState';
import type { Agent, AuditLine, EvidenceItem, Run, RunState, AgentName } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';

/**
 * Mission Control: 7-stage pipeline + 460px right drawer with 4 tabs.
 * Reactive to bus events `run.transition` and `run.audit` via the Zustand store.
 */

type StageId = 'queued' | 'running' | 'publishing' | 'paused' | 'failed' | 'done';

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
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('mc.drawerOpen');
      return v === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('mc.drawerOpen', drawerOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [drawerOpen]);

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
  }, [repo, upsertRun]);

  const agentLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.displayName);
    return m;
  }, [agents]);

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
                        selected={run.id === selectedRunId}
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setDrawerOpen(true);
                        }}
                        onDelete={() => void handleDeleteRun(run.id)}
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
  selected,
  onClick,
  onDelete,
}: {
  run: Run;
  instanceName?: string;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
}): ReactElement {
  const typeLabel = agentLabel(run.agentName);
  const showInstance = instanceName && instanceName !== typeLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuOpen, menuRef, () => setMenuOpen(false));

  const isActive = run.state === 'queued' || run.state === 'running' || run.state === 'publishing';

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
      <div className="mc-card-head">
        <div className="mc-card-title">{run.taskRef ?? '(no task ref)'}</div>
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
              <button
                type="button"
                role="menuitem"
                className="mc-card-menu-item bad"
                disabled={isActive}
                title={isActive ? 'Cancel the run before deleting' : undefined}
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
    </div>
  );
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
  }
}

function agentLabel(name: AgentName): string {
  return {
    'qa-hunter': 'QA Hunter',
    'manual-qa': 'Manual QA',
    'bug-fixer': 'Bug Fixer',
    'feature-builder': 'Feature Builder',
    'pr-reviewer': 'PR Reviewer',
    'ios-qa-pilot': 'iOS QA Pilot',
  }[name];
}

type Tab = 'audit' | 'evidence' | 'reasoning' | 'files';

function RunDrawer({
  run,
  onClose,
  onToggle,
  onDelete,
}: {
  run: Run | null;
  onClose: () => void;
  onToggle: () => void;
  onDelete: (runId: string) => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('audit');
  const [details, setDetails] = useState<{
    auditLog: AuditLine[];
    evidence: EvidenceItem[];
  } | null>(null);

  useEffect(() => {
    if (!run) {
      setDetails(null);
      return;
    }
    void window.obelisk.invoke('runs:get', { runId: run.id }).then((res) => {
      if (res.ok) setDetails({ auditLog: res.value.auditLog, evidence: res.value.evidence });
    });
  }, [run]);

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

  return (
    <aside className="mc-drawer">
      <div className="mc-drawer-toolbar">
        <button
          type="button"
          className="btn ghost icon"
          onClick={() => onDelete(run.id)}
          disabled={isActive}
          title={isActive ? 'Cancel the run before deleting' : 'Delete this run and its evidence'}
        >
          <Icon.Trash size={11} />
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost icon" onClick={onClose} title="Deselect">
          <Icon.Close size={11} />
        </button>
        {toggleBtn}
      </div>
      <div className="mc-drawer-header">
        <div className="mc-drawer-title">{run.taskRef ?? '(no task ref)'}</div>
        <div className="mc-drawer-meta">
          <span className="pill" title={`Agent type: ${agentLabel(run.agentName)}`}>
            {agentLabel(run.agentName)}
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
      </div>
      <div className="mc-tabs">
        {(['audit', 'evidence', 'reasoning', 'files'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`mc-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mc-tab-body">
        {tab === 'audit' && <AuditTab lines={details?.auditLog ?? []} />}
        {tab === 'evidence' && <EvidenceTab evidence={details?.evidence ?? []} />}
        {tab === 'reasoning' && <ReasoningTab lines={details?.auditLog ?? []} />}
        {tab === 'files' && <FilesTab evidence={details?.evidence ?? []} />}
      </div>
    </aside>
  );
}

function AuditTab({ lines }: { lines: AuditLine[] }): ReactElement {
  if (lines.length === 0) return <Empty>No audit entries yet.</Empty>;
  return (
    <div className="col gap-1">
      {lines.map((l) => (
        <div key={l.id} className="mc-audit-row">
          <span className="mc-audit-time">{shortTime(l.at)}</span>
          <span className="mc-audit-kind">{l.kind}</span>
          <div className="mc-audit-msg">{describePayload(l.payload)}</div>
        </div>
      ))}
    </div>
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
