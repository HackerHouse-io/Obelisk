import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import type { Agent, BacklogItem, IpcMap, Run, RunState, AgentName } from '../../shared/types';
import { Icon } from '../icons';
import { EmptyState } from '../ui/EmptyState';

type PreviewsResponse = IpcMap['previews:list']['res'];

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
  const [runs, setRuns] = useState<Run[]>([]);
  const [backlog, setBacklog] = useState<BacklogItem[]>([]);
  const [previews, setPreviews] = useState<PreviewsResponse>({
    findings: [],
    playbookDraft: null,
  });

  useEffect(() => {
    if (!repo) return;
    void Promise.all([
      window.obelisk.invoke('agents:list', { repoId: repo.id }),
      window.obelisk.invoke('runs:list', { repoId: repo.id, limit: 50 }),
      window.obelisk.invoke('backlog:list', { repoId: repo.id }),
      window.obelisk.invoke('previews:list', { repoId: repo.id }),
    ]).then(([a, r, b, p]) => {
      if (a.ok) setAgents(a.value);
      if (r.ok) setRuns(r.value);
      if (b.ok) setBacklog(b.value);
      if (p.ok) setPreviews(p.value);
    });
  }, [repo]);

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

      {repo.mode === 'observe' &&
      (previews.findings.length > 0 || previews.playbookDraft !== null) ? (
        <ObservePreviews
          findings={previews.findings}
          playbookDraft={previews.playbookDraft}
          onUpgradeMode={() => setRoute('settings')}
          onOpenPlaybook={() => setRoute('playbook')}
        />
      ) : null}

      <div className="home-section">
        <div className="home-section-title">
          Agents
          <button type="button" className="btn ghost sm" onClick={() => setRoute('agents')}>
            Configure
          </button>
        </div>
        {agents.length === 0 ? (
          <div className="home-table-empty">No agents installed.</div>
        ) : (
          <div className="home-table">
            {agents.map((a) => (
              <div key={a.id} className="home-table-row">
                <span
                  className="dot"
                  style={{ background: a.enabled ? 'var(--ok)' : 'var(--t-3)' }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>{labelFor(a.name)}</div>
                  <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                    {a.runnerOverride ?? repo.defaultRunner} ·{' '}
                    {a.scheduleCron ?? 'default schedule'}
                  </div>
                </div>
                <span className="pill">{a.enabled ? 'enabled' : 'paused'}</span>
                <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                  {a.timeoutMs / 1000 / 60}m timeout
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

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
            {runs.slice(0, 8).map((r) => (
              <div key={r.id} className="home-table-row">
                <Icon.Pipeline size={14} color="var(--t-2)" />
                <div>
                  <div style={{ fontWeight: 600 }}>{r.taskRef ?? '(no task ref)'}</div>
                  <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                    {labelFor(r.agentName)} · {r.runnerUsed} · {r.outputSummary ?? '—'}
                  </div>
                </div>
                <span className={`pill ${stateTone(r.state)}`}>{r.state}</span>
                <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                  {r.startedAt ? short(r.startedAt) : ''}
                </span>
              </div>
            ))}
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
                <div>
                  <div style={{ fontWeight: 600 }}>{b.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                    {b.kind} · {b.priorityLabel ?? 'no priority'} ·{' '}
                    {b.githubIssue ? `#${b.githubIssue}` : 'manual'}
                  </div>
                </div>
                <span
                  className={`pill ${b.priorityLabel === 'P0' ? 'bad' : b.priorityLabel === 'P1' ? 'warn' : ''}`}
                >
                  {b.priorityLabel ?? '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-2)' }}>
                  {b.inProgressRun ? 'in flight' : 'queued'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
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

function ObservePreviews({
  findings,
  playbookDraft,
  onUpgradeMode,
  onOpenPlaybook,
}: {
  findings: PreviewsResponse['findings'];
  playbookDraft: PreviewsResponse['playbookDraft'];
  onUpgradeMode: () => void;
  onOpenPlaybook: () => void;
}): ReactElement {
  const [expandedId, setExpandedId] = useState<number | null>(null);
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
        GitHub. These are the issues and playbook files agents would have filed otherwise.
      </div>

      {playbookDraft ? (
        <div className="preview-card">
          <div className="row gap-2" style={{ alignItems: 'center' }}>
            <Icon.Playbook size={13} color="var(--t-1)" />
            <div style={{ fontWeight: 600, fontSize: 13 }}>QA playbook draft</div>
            <span className="pill" style={{ marginLeft: 'auto' }}>
              draft
            </span>
          </div>
          <div className="preview-card-sub">
            Detected framework <span className="mono">{playbookDraft.framework}</span> ·{' '}
            {playbookDraft.fileCount} file{playbookDraft.fileCount === 1 ? '' : 's'} ·{' '}
            {playbookDraft.criticalFlows.length} critical flow
            {playbookDraft.criticalFlows.length === 1 ? '' : 's'} · generated{' '}
            {short(playbookDraft.generatedAt)}
          </div>
          <div className="row gap-2">
            <button type="button" className="btn sm" onClick={onOpenPlaybook}>
              <Icon.Doc size={11} /> Review draft
            </button>
            <button type="button" className="btn sm" onClick={onUpgradeMode}>
              Open as PR
            </button>
          </div>
        </div>
      ) : null}

      {findings.length === 0 ? (
        <div className="home-table-empty">
          No previewed findings yet. QA Hunter and Manual QA write here on their next run.
        </div>
      ) : (
        <div className="home-table">
          {findings.map((f) => {
            const expanded = expandedId === f.id;
            return (
              <div key={f.id} className="preview-row">
                <button
                  type="button"
                  className="preview-row-head"
                  onClick={() => setExpandedId(expanded ? null : f.id)}
                >
                  <Icon.Issue size={13} color="var(--t-2)" />
                  <div className="preview-row-title">
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
                      {labelFor(f.agentName)} · {short(f.at)}
                    </div>
                  </div>
                  <div className="row gap-1">
                    {f.labels.map((l) => (
                      <span key={l} className="pill">
                        {l}
                      </span>
                    ))}
                  </div>
                  <Icon.ChevronDown
                    size={11}
                    color="var(--t-2)"
                    style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                  />
                </button>
                {expanded ? <pre className="preview-row-body">{f.body}</pre> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function labelFor(name: AgentName): string {
  return {
    'qa-hunter': 'QA Hunter',
    'manual-qa': 'Manual QA',
    'bug-fixer': 'Bug Fixer',
    'feature-builder': 'Feature Builder',
    'pr-reviewer': 'PR Reviewer',
  }[name];
}

function stateTone(s: RunState): string {
  switch (s) {
    case 'done':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'paused':
      return 'warn';
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
