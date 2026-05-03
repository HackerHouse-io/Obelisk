import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon, type IconName } from '../icons';
import { useStore } from '../state/store';
import type { Agent, AgentName, RunnerKind } from '../../shared/types';

interface AgentMeta {
  name: AgentName;
  label: string;
  role: string;
  icon: IconName;
  defaultRunner: RunnerKind;
  defaultSchedule: string;
}

const AGENTS: AgentMeta[] = [
  {
    name: 'qa-hunter',
    label: 'QA Hunter',
    role: 'Static + test inspection',
    icon: 'Eye',
    defaultRunner: 'claude',
    defaultSchedule: '0 2 * * *',
  },
  {
    name: 'manual-qa',
    label: 'Manual QA',
    role: 'Playwright drives the app',
    icon: 'Camera',
    defaultRunner: 'codex',
    defaultSchedule: '0 * * * *',
  },
  {
    name: 'bug-fixer',
    label: 'Bug Fixer',
    role: 'Fix → test → PR',
    icon: 'Bug',
    defaultRunner: 'claude',
    defaultSchedule: '0 */2 * * *',
  },
  {
    name: 'feature-builder',
    label: 'Feature Builder',
    role: 'Spec → plan → ship',
    icon: 'Sparkles',
    defaultRunner: 'claude',
    defaultSchedule: '0 */6 * * *',
  },
  {
    name: 'pr-reviewer',
    label: 'PR Reviewer',
    role: '5-axis staff review',
    icon: 'Shield',
    defaultRunner: 'claude',
    defaultSchedule: 'On every PR',
  },
];

const POST_MVP: { label: string; role: string; icon: IconName }[] = [
  { label: 'Test Engineer', role: 'Coverage + flaky-test cleanup', icon: 'Code' },
  { label: 'Security Auditor', role: 'OWASP + secret scanning', icon: 'Lock' },
  { label: 'Product Polish', role: 'UI consistency sweeps', icon: 'Spark' },
  { label: 'Docs Writer', role: 'README + ADRs', icon: 'Doc' },
  { label: 'Refactor Bot', role: 'Lift-and-shift refactors', icon: 'Sliders' },
];

export function AgentsScreen(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedName, setSelectedName] = useState<AgentName>('bug-fixer');

  const refresh = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('agents:list', { repoId: repo.id });
    if (res.ok) setAgents(res.value);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  const selectedAgentRow = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );
  const selectedMeta = AGENTS.find((m) => m.name === selectedName)!;

  if (!repo) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">No repo connected</div>
        <div className="placeholder-body">Open Connect Repo first.</div>
      </div>
    );
  }

  async function update(patch: Partial<Agent>): Promise<void> {
    if (!selectedAgentRow) return;
    const res = await window.obelisk.invoke('agents:update', {
      agentId: selectedAgentRow.id,
      patch,
    });
    if (res.ok) await refresh();
    else alert(res.error.message);
  }

  async function runNow(): Promise<void> {
    const res = await window.obelisk.invoke('agents:run', {
      repoId: repo!.id,
      agentName: selectedName,
    });
    if (!res.ok) alert(res.error.message);
  }

  return (
    <div className="agents-screen">
      <aside className="agents-list">
        <div className="agents-list-section-title">Installed</div>
        {AGENTS.map((meta) => {
          const row = agents.find((a) => a.name === meta.name);
          const IconCmp = Icon[meta.icon];
          return (
            <button
              key={meta.name}
              type="button"
              className={`agents-list-item${selectedName === meta.name ? ' selected' : ''}`}
              onClick={() => setSelectedName(meta.name)}
            >
              <div className="agents-list-item-icon">
                <IconCmp size={14} color="var(--brand)" />
              </div>
              <div>
                <div className="agents-list-item-name">{meta.label}</div>
                <div className="agents-list-item-role">{meta.role}</div>
              </div>
              <span
                className="dot"
                style={{
                  background: row?.enabled ? 'var(--ok)' : 'var(--t-3)',
                  color: row?.enabled ? 'var(--ok)' : 'var(--t-3)',
                }}
              />
            </button>
          );
        })}

        <div className="agents-list-section-title" style={{ marginTop: 8 }}>
          Available · post-MVP
        </div>
        {POST_MVP.map((m) => {
          const IconCmp = Icon[m.icon];
          return (
            <div
              key={m.label}
              className="agents-list-item"
              style={{ opacity: 0.5, cursor: 'default' }}
            >
              <div className="agents-list-item-icon">
                <IconCmp size={14} color="var(--t-2)" />
              </div>
              <div>
                <div className="agents-list-item-name">{m.label}</div>
                <div className="agents-list-item-role">Coming soon · {m.role}</div>
              </div>
              <span />
            </div>
          );
        })}
      </aside>

      <div className="agents-detail">
        <div className="agents-detail-header">
          <div className="agents-detail-icon">
            {(() => {
              const IconCmp = Icon[selectedMeta.icon];
              return <IconCmp size={20} color="var(--brand)" />;
            })()}
          </div>
          <div>
            <div className="agents-detail-title">
              {selectedMeta.label}
              <span
                className="pill"
                style={{
                  marginLeft: 10,
                  background:
                    selectedAgentRow?.enabled === false ? 'var(--bg-3)' : 'var(--ok-soft)',
                  color: selectedAgentRow?.enabled === false ? 'var(--t-2)' : 'oklch(82% 0.14 152)',
                  borderColor:
                    selectedAgentRow?.enabled === false
                      ? 'var(--line-strong)'
                      : 'oklch(70% 0.14 152 / 0.4)',
                }}
              >
                {selectedAgentRow?.enabled === false ? 'paused' : 'enabled'}
              </span>
            </div>
            <div className="agents-detail-role">{selectedMeta.role}</div>
          </div>
          <div className="agents-detail-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void update({ enabled: !(selectedAgentRow?.enabled ?? true) });
              }}
            >
              {selectedAgentRow?.enabled === false ? (
                <>
                  <Icon.Play size={11} /> Enable
                </>
              ) : (
                <>
                  <Icon.Pause size={11} /> Pause
                </>
              )}
            </button>
            <button type="button" className="btn primary" onClick={runNow}>
              <Icon.Play size={11} /> Run now
            </button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">Mission</div>
          <div className="settings-card-sub">
            The agent&apos;s role and output contract are defined in{' '}
            <span className="mono">agents/{selectedMeta.name}.md</span>. Per-repo overrides under{' '}
            <span className="mono">&lt;repo&gt;/agents/</span> always win.
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">Runner</div>
          <div className="settings-card-sub">
            Override the repo&apos;s default CLI runner for this agent only.
          </div>
          <div className="row gap-2">
            {(['default', 'claude', 'codex'] as const).map((opt) => {
              const active =
                opt === 'default'
                  ? selectedAgentRow?.runnerOverride == null
                  : selectedAgentRow?.runnerOverride === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  className={`btn${active ? ' primary' : ''}`}
                  onClick={() => {
                    void update({
                      runnerOverride: opt === 'default' ? null : (opt as RunnerKind),
                    });
                  }}
                >
                  {opt === 'default'
                    ? 'Use repo default'
                    : opt === 'claude'
                      ? 'Claude Code'
                      : 'Codex'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">Schedule</div>
          <div className="settings-card-sub">
            Cron expression in 5-field UTC format. Leave blank to use the built-in default
            (currently <span className="mono">{selectedMeta.defaultSchedule}</span>). Animated
            schedule editor lands in v0.2.
          </div>
          <div className="row gap-2">
            <input
              className="input settings-input"
              placeholder={selectedMeta.defaultSchedule}
              defaultValue={selectedAgentRow?.scheduleCron ?? ''}
              onBlur={(e) => {
                const next = e.target.value.trim();
                void update({ scheduleCron: next.length === 0 ? null : next });
              }}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              timeout: {Math.round((selectedAgentRow?.timeoutMs ?? 0) / 60000)}m
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
