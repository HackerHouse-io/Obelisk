import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import { EmptyState } from '../ui/EmptyState';
import type { Agent, AuditLine, EvidenceItem, Run, RunState, AgentName } from '../../shared/types';

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
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('mc.drawerOpen');
      return v === null ? true : v === '1';
    } catch {
      return true;
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
    <div className={`mc${drawerOpen ? '' : ' drawer-closed'}`}>
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
}: {
  run: Run;
  instanceName?: string;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  const typeLabel = agentLabel(run.agentName);
  const showInstance = instanceName && instanceName !== typeLabel;
  return (
    <button type="button" className={`mc-card${selected ? ' selected' : ''}`} onClick={onClick}>
      <div className="mc-card-title">{run.taskRef ?? '(no task ref)'}</div>
      <div className="mc-card-meta">
        <span className="pill" title={showInstance ? typeLabel : undefined}>
          {instanceName ?? typeLabel}
        </span>
        {showInstance ? (
          <span className="pill" style={{ opacity: 0.7 }}>
            {typeLabel}
          </span>
        ) : null}
        <span className="pill">{run.runnerUsed}</span>
        {run.fallbackUsed ? <span className="pill warn">fallback</span> : null}
        {run.errorCode ? <span className="pill bad">{run.errorCode}</span> : null}
      </div>
    </button>
  );
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
}: {
  run: Run | null;
  onClose: () => void;
  onToggle: () => void;
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

  return (
    <aside className="mc-drawer">
      <div className="mc-drawer-header">
        <div className="mc-drawer-row">
          <div className="mc-drawer-title">{run.taskRef ?? '(no task ref)'}</div>
          <div className="row gap-1">
            <button type="button" className="btn ghost icon" onClick={onClose} title="Close">
              <Icon.Close size={11} />
            </button>
            {toggleBtn}
          </div>
        </div>
        <div className="mc-drawer-meta">
          <span className="pill">{agentLabel(run.agentName)}</span>
          <span className="pill">{run.runnerUsed}</span>
          <span className="pill">{run.state}</span>
          {run.errorCode ? <span className="pill bad">{run.errorCode}</span> : null}
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
