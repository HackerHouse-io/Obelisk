import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Icon, type IconName } from '../icons';
import { useStore } from '../state/store';
import type {
  Agent,
  AgentName,
  AgentPermissions,
  RunnerKind,
  ScheduleConfig,
  ScheduleMode,
} from '../../shared/types';
import { EmptyState } from '../ui/EmptyState';

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
  {
    name: 'ios-qa-pilot',
    label: 'iOS QA Pilot',
    role: 'Appium drives an iOS sim',
    icon: 'Camera',
    defaultRunner: 'claude',
    defaultSchedule: 'Manual / on-demand',
  },
];

const POST_MVP: { label: string; role: string; icon: IconName }[] = [
  { label: 'Test Engineer', role: 'Coverage + flaky-test cleanup', icon: 'Code' },
  { label: 'Security Auditor', role: 'OWASP + secret scanning', icon: 'Lock' },
  { label: 'Product Polish', role: 'UI consistency sweeps', icon: 'Spark' },
  { label: 'Docs Writer', role: 'README + ADRs', icon: 'Doc' },
  { label: 'Refactor Bot', role: 'Lift-and-shift refactors', icon: 'Sliders' },
];

function metaFor(name: AgentName): AgentMeta {
  return AGENTS.find((m) => m.name === name) ?? AGENTS[0]!;
}

export function AgentsScreen(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSeed, setPickerSeed] = useState<AgentName | null>(null);

  const refresh = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('agents:list', { repoId: repo.id });
    if (res.ok) {
      setAgents(res.value);
      // Auto-select the first agent on first load.
      if (res.value.length > 0 && !res.value.find((a) => a.id === selectedAgentId)) {
        setSelectedAgentId(res.value[0]!.id);
      }
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Agents are configured per-repo. Connect one first."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }

  // Group instances by type, preserving the canonical AGENTS order.
  const grouped = AGENTS.map((meta) => ({
    meta,
    instances: agents.filter((a) => a.name === meta.name),
  }));

  async function createOf(name: AgentName, displayName?: string): Promise<void> {
    const res = await window.obelisk.invoke('agents:create', {
      repoId: repo!.id,
      name,
      ...(displayName ? { displayName } : {}),
    });
    if (!res.ok) {
      alert(res.error.message + (res.error.hint ? `\n\n${res.error.hint}` : ''));
      return;
    }
    setSelectedAgentId(res.value.id);
    await refresh();
  }

  async function cloneInstance(agentId: string): Promise<void> {
    const res = await window.obelisk.invoke('agents:clone', { agentId });
    if (!res.ok) {
      alert(res.error.message);
      return;
    }
    setSelectedAgentId(res.value.id);
    await refresh();
  }

  async function deleteInstance(agentId: string, displayName: string): Promise<void> {
    if (
      !confirm(
        `Delete ${displayName}? This removes the instance and its scheduling. Run history is kept.`,
      )
    )
      return;
    const res = await window.obelisk.invoke('agents:delete', { agentId });
    if (!res.ok) {
      alert(res.error.message);
      return;
    }
    await refresh();
    if (selectedAgentId === agentId) {
      setSelectedAgentId(agents.find((a) => a.id !== agentId)?.id ?? null);
    }
  }

  return (
    <div className="agents-screen">
      <aside className="agents-list">
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Agents</h2>
          <span className="pill" style={{ fontSize: 10.5 }}>
            {agents.length} runner{agents.length === 1 ? '' : 's'}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn primary sm"
            onClick={() => {
              setPickerSeed(null);
              setPickerOpen(true);
            }}
          >
            <Icon.Plus size={11} /> Add agent
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {grouped.map(({ meta, instances }) => (
            <AgentGroup
              key={meta.name}
              meta={meta}
              instances={instances}
              selectedId={selectedAgentId}
              onSelect={setSelectedAgentId}
              onAddAnother={() => {
                setPickerSeed(meta.name);
                setPickerOpen(true);
              }}
              onClone={cloneInstance}
              onDelete={deleteInstance}
            />
          ))}

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
        </div>
      </aside>

      {selectedAgent ? (
        <AgentDetail
          agent={selectedAgent}
          onChanged={refresh}
          onDelete={() => deleteInstance(selectedAgent.id, selectedAgent.displayName)}
        />
      ) : (
        <div style={{ padding: 28 }}>
          <EmptyState
            title="No agents installed"
            body="Add a runner to start picking up bugs, features, or PRs."
            action={{
              label: 'Add agent',
              icon: <Icon.Plus size={13} />,
              onClick: () => {
                setPickerSeed(null);
                setPickerOpen(true);
              },
            }}
          />
        </div>
      )}

      {pickerOpen ? (
        <AddAgentPicker
          existingByName={Object.fromEntries(
            grouped.map(({ meta, instances }) => [meta.name, instances.length]),
          )}
          seed={pickerSeed}
          onCancel={() => setPickerOpen(false)}
          onPick={async (name) => {
            setPickerOpen(false);
            await createOf(name);
          }}
        />
      ) : null}
    </div>
  );
}

/* ───────────────────────── Sidebar groups ───────────────────────── */

interface GroupProps {
  meta: AgentMeta;
  instances: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddAnother: () => void;
  onClone: (id: string) => Promise<void>;
  onDelete: (id: string, displayName: string) => Promise<void>;
}

function AgentGroup({
  meta,
  instances,
  selectedId,
  onSelect,
  onAddAnother,
  onClone,
  onDelete,
}: GroupProps): ReactElement {
  const IconCmp = Icon[meta.icon];
  const singleton = instances.length > 0 ? !instances[0]!.multiInstance : false;
  const addDisabled = singleton && instances.length > 0;
  return (
    <div>
      <div
        style={{
          padding: '10px 14px 4px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--t-3)',
            textTransform: 'uppercase',
            letterSpacing: 0.05,
            fontWeight: 700,
          }}
        >
          {meta.label}
          <span style={{ marginLeft: 6, color: 'var(--t-3)', fontWeight: 500 }}>
            · {instances.length}
          </span>
        </span>
        <div style={{ flex: 1 }} />
        {addDisabled ? null : (
          <button
            type="button"
            className="btn ghost sm"
            onClick={onAddAnother}
            title={`Add another ${meta.label}`}
          >
            <Icon.Plus size={10} />
          </button>
        )}
      </div>
      {instances.length === 0 ? (
        <div
          className="agents-list-item"
          style={{ opacity: 0.5, cursor: 'default' }}
          aria-hidden="true"
        >
          <div className="agents-list-item-icon">
            <IconCmp size={14} color="var(--t-2)" />
          </div>
          <div>
            <div className="agents-list-item-name" style={{ color: 'var(--t-2)' }}>
              {meta.label}
            </div>
            <div className="agents-list-item-role">Not installed</div>
          </div>
          <span />
        </div>
      ) : (
        instances.map((a) => (
          <SidebarRow
            key={a.id}
            agent={a}
            meta={meta}
            selected={selectedId === a.id}
            onSelect={() => onSelect(a.id)}
            onClone={() => onClone(a.id)}
            onDelete={() => onDelete(a.id, a.displayName)}
          />
        ))
      )}
    </div>
  );
}

interface RowProps {
  agent: Agent;
  meta: AgentMeta;
  selected: boolean;
  onSelect: () => void;
  onClone: () => void;
  onDelete: () => void;
}

function SidebarRow({
  agent,
  meta,
  selected,
  onSelect,
  onClone,
  onDelete,
}: RowProps): ReactElement {
  const IconCmp = Icon[meta.icon];
  const [menuOpen, setMenuOpen] = useState(false);
  const dotColor = !agent.enabled ? 'var(--t-3)' : agent.nextFireAt ? 'var(--ok)' : 'var(--warn)';
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className={`agents-list-item${selected ? ' selected' : ''}`}
        onClick={onSelect}
        style={{ paddingRight: 70 }}
      >
        <div className="agents-list-item-icon">
          <IconCmp size={14} color="var(--brand)" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            className="agents-list-item-name"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {agent.displayName}
          </div>
          <div className="agents-list-item-role">
            {agent.runnerOverride ?? 'default'} · {scheduleSummary(agent, meta)}
          </div>
        </div>
      </button>
      <div
        style={{
          position: 'absolute',
          top: '50%',
          right: 10,
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          pointerEvents: 'none',
        }}
      >
        <span className="dot" style={{ background: dotColor, color: dotColor }} />
        <button
          type="button"
          className="btn ghost icon"
          title="More actions"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((m) => !m);
          }}
          style={{
            height: 22,
            width: 22,
            opacity: 0.7,
            pointerEvents: 'auto',
          }}
        >
          ⋯
        </button>
      </div>
      {menuOpen ? (
        <div
          style={{
            position: 'absolute',
            top: 30,
            right: 8,
            zIndex: 20,
            background: 'var(--bg-1)',
            border: '1px solid var(--line-strong)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-2)',
            minWidth: 140,
            padding: 4,
          }}
        >
          {agent.multiInstance ? (
            <MenuItem
              label="Duplicate"
              onClick={() => {
                setMenuOpen(false);
                void onClone();
              }}
            />
          ) : null}
          <MenuItem
            label="Delete"
            destructive
            onClick={() => {
              setMenuOpen(false);
              void onDelete();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  destructive,
  onClick,
}: {
  label: string;
  destructive?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 12,
        color: destructive ? 'var(--err)' : 'var(--t-0)',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  );
}

/* ───────────────────────── Add Agent Picker ───────────────────────── */

interface PickerProps {
  existingByName: Record<string, number>;
  seed: AgentName | null;
  onCancel: () => void;
  onPick: (name: AgentName) => Promise<void>;
}

const PICKER_EXPLAINERS: Record<AgentName, { explainer: string; singleton: boolean }> = {
  'bug-fixer': {
    explainer:
      'Each instance picks a different bug per tick. Adding more drains the backlog faster.',
    singleton: false,
  },
  'feature-builder': {
    explainer:
      'Each instance ships a different feature in parallel — distinct backlog rows, no overlap.',
    singleton: false,
  },
  'pr-reviewer': {
    explainer:
      'Each instance reviews a different PR. The same PR is never reviewed twice at the same SHA.',
    singleton: false,
  },
  'ios-qa-pilot': {
    explainer: 'Each instance binds to a different simulator and verifies a different flow.',
    singleton: false,
  },
  'qa-hunter': {
    explainer: 'QA Hunter sweeps the whole repo on every run — only one instance is useful.',
    singleton: true,
  },
  'manual-qa': {
    explainer:
      'Manual QA runs every flow in qa/critical-flows.md per sweep — only one is useful today.',
    singleton: true,
  },
};

function AddAgentPicker({ existingByName, seed, onCancel, onPick }: PickerProps): ReactElement {
  const [hovered, setHovered] = useState<AgentName | null>(seed);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-0)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          width: 720,
          maxWidth: 'calc(100vw - 60px)',
          maxHeight: 'calc(100vh - 80px)',
          overflow: 'auto',
          boxShadow: 'var(--shadow-3)',
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Icon.Plus size={14} color="var(--brand-text)" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Add a runner</h2>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-2)', marginBottom: 14, lineHeight: 1.5 }}>
          Each agent runs as a single process. Add multiple instances of the same type to
          parallelize the work — claim primitives guarantee no two instances pick the same unit.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {AGENTS.map((meta) => {
            const info = PICKER_EXPLAINERS[meta.name];
            const installed = existingByName[meta.name] ?? 0;
            const blocked = info.singleton && installed > 0;
            const IconCmp = Icon[meta.icon];
            return (
              <div
                key={meta.name}
                onMouseEnter={() => setHovered(meta.name)}
                style={{
                  border: `1px solid ${hovered === meta.name ? 'var(--brand-line)' : 'var(--line)'}`,
                  background: hovered === meta.name ? 'var(--brand-soft)' : 'var(--bg-1)',
                  borderRadius: 8,
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  opacity: blocked ? 0.55 : 1,
                  transition: 'background 160ms, border-color 160ms',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 7,
                      background: 'var(--bg-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <IconCmp size={15} color="var(--brand)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-2)' }}>{meta.role}</div>
                  </div>
                  {info.singleton ? (
                    <span className="pill" style={{ fontSize: 10 }}>
                      <Icon.Lock size={9} /> Singleton
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--t-1)', lineHeight: 1.45 }}>
                  {info.explainer}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--t-3)' }}>
                  {installed > 0 ? `Already installed: ${installed}` : 'No instance installed yet'}
                </div>
                <button
                  type="button"
                  className={`btn ${blocked ? 'ghost' : 'primary'} sm`}
                  disabled={blocked}
                  title={
                    blocked
                      ? `Only one ${meta.label} instance is supported. ${info.explainer}`
                      : `Add another ${meta.label}`
                  }
                  onClick={() => {
                    if (!blocked) void onPick(meta.name);
                  }}
                  style={{ alignSelf: 'flex-start' }}
                >
                  <Icon.Plus size={10} /> Add {meta.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Detail pane ───────────────────────── */

interface DetailProps {
  agent: Agent;
  onChanged: () => Promise<void>;
  onDelete: () => Promise<void>;
}

function AgentDetail({ agent, onChanged, onDelete }: DetailProps): ReactElement {
  const meta = metaFor(agent.name);
  const IconCmp = Icon[meta.icon];
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(agent.displayName);

  useEffect(() => {
    setRenameValue(agent.displayName);
  }, [agent.id, agent.displayName]);

  async function update(patch: Partial<Agent>): Promise<void> {
    const res = await window.obelisk.invoke('agents:update', {
      agentId: agent.id,
      patch,
    });
    if (!res.ok) {
      alert(res.error.message);
      return;
    }
    await onChanged();
  }

  async function runNow(): Promise<void> {
    const res = await window.obelisk.invoke('agents:run', { agentId: agent.id });
    if (!res.ok) alert(res.error.message);
  }

  return (
    <div className="agents-detail" key={agent.id}>
      <div className="agents-detail-header">
        <div className="agents-detail-icon">
          <IconCmp size={20} color="var(--brand)" />
        </div>
        <div className="agents-detail-meta">
          <div className="agents-detail-title">
            {renaming ? (
              <input
                autoFocus
                className="input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => {
                  setRenaming(false);
                  if (renameValue.trim() && renameValue !== agent.displayName) {
                    void update({ displayName: renameValue.trim() });
                  } else {
                    setRenameValue(agent.displayName);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setRenameValue(agent.displayName);
                    setRenaming(false);
                  }
                }}
                style={{ fontSize: 18, fontWeight: 600, padding: '2px 8px', minWidth: 200 }}
              />
            ) : (
              <span
                onDoubleClick={() => setRenaming(true)}
                title="Double-click to rename"
                style={{ cursor: 'text' }}
              >
                {agent.displayName}
              </span>
            )}
            <span className="pill" style={{ fontSize: 10.5 }}>
              {meta.label}
            </span>
            <span className={`pill ${agent.enabled ? 'ok' : ''}`} style={{ fontSize: 10.5 }}>
              {agent.enabled ? 'enabled' : 'paused'}
            </span>
          </div>
          <div className="agents-detail-role">{meta.role}</div>
        </div>
        <div className="agents-detail-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void update({ enabled: !agent.enabled })}
          >
            {agent.enabled ? (
              <>
                <Icon.Pause size={11} /> Pause
              </>
            ) : (
              <>
                <Icon.Play size={11} /> Enable
              </>
            )}
          </button>
          <button type="button" className="btn primary" onClick={runNow}>
            <Icon.Play size={11} /> Run now
          </button>
          <button type="button" className="btn ghost" onClick={() => void onDelete()}>
            <Icon.Doc size={11} /> Delete
          </button>
        </div>
      </div>

      <StatsCard agent={agent} />
      <MissionCard agent={agent} />
      <SkillsCard agent={agent} />
      <PermissionsCard agent={agent} onUpdate={update} />
      <RunnerModelCard agent={agent} onUpdate={update} />
      <ScheduleEditorCard agent={agent} onUpdate={update} />
      <HistoryGridCard agent={agent} />
    </div>
  );
}

/* ───────────────────────── Stats card ───────────────────────── */

interface Stats {
  runs: number;
  prsOpened: number;
  issuesFiled: number;
  reviewsLeft: number;
  falsePositiveRate: number;
  avgDurationMs: number;
}

function StatsCard({ agent }: { agent: Agent }): ReactElement {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.obelisk.invoke('runs:stats', { agentId: agent.id, days: 7 }).then((r) => {
      if (!cancelled && r.ok) setStats(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const renderForKind = primaryStatFor(agent.name);
  return (
    <div className="settings-card">
      <div className="settings-card-title">Last 7 days</div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 8 }}
      >
        <Stat label="Runs" value={stats?.runs ?? 0} />
        <Stat label={renderForKind.label} value={renderForKind.pluck(stats)} />
        <Stat
          label="Failure rate"
          value={`${Math.round((stats?.falsePositiveRate ?? 0) * 100)}%`}
          good={stats != null && stats.falsePositiveRate < 0.15}
        />
        <Stat label="Avg duration" value={fmtDuration(stats?.avgDurationMs ?? 0)} mono />
      </div>
    </div>
  );
}

function primaryStatFor(name: AgentName): {
  label: string;
  pluck: (s: Stats | null) => number | string;
} {
  switch (name) {
    case 'bug-fixer':
    case 'feature-builder':
      return { label: 'PRs opened', pluck: (s) => s?.prsOpened ?? 0 };
    case 'pr-reviewer':
      return { label: 'Reviews left', pluck: (s) => s?.reviewsLeft ?? 0 };
    default:
      return { label: 'Issues filed', pluck: (s) => s?.issuesFiled ?? 0 };
  }
}

function Stat({
  label,
  value,
  good,
  mono,
}: {
  label: string;
  value: number | string;
  good?: boolean;
  mono?: boolean;
}): ReactElement {
  const color = good == null ? 'var(--t-0)' : good ? 'var(--ok)' : 'var(--warn)';
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--t-2)',
          textTransform: 'uppercase',
          letterSpacing: 0.04,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          marginTop: 4,
          color,
          fontFamily: mono ? 'var(--mono)' : 'inherit',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (ms === 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s.toString().padStart(2, '0')}s`;
}

/* ───────────────────────── Mission + Skills ───────────────────────── */

interface AgentMd {
  source: 'builtin' | 'override';
  markdown: string;
  skills: string[];
}

function MissionCard({ agent }: { agent: Agent }): ReactElement {
  const repos = useStore((s) => s.repos);
  const repo = repos.find((r) => r.id === agent.repoId);
  const [data, setData] = useState<AgentMd | null>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void window.obelisk
      .invoke('agents:readMd', { repoId: repo.id, agentName: agent.name })
      .then((r) => {
        if (!cancelled && r.ok) setData(r.value);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.name, repo?.id]);

  const body = data?.markdown ?? '';
  const trimmed = body.replace(/^---[\s\S]*?---\s*/m, '').trim();
  return (
    <div className="settings-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="settings-card-title">Mission</div>
        <div style={{ flex: 1 }} />
        <span className="pill" style={{ fontSize: 10 }}>
          {data?.source === 'override' ? 'repo override' : 'built-in'}
        </span>
      </div>
      <div className="settings-card-sub">
        Defined in <span className="mono">agents/{agent.name}.md</span>. Per-repo overrides under{' '}
        <span className="mono">&lt;repo&gt;/agents/</span> always win.
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          lineHeight: 1.6,
          color: 'var(--t-1)',
          background: 'var(--bg-0)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: 12,
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          marginTop: 8,
        }}
      >
        {trimmed || '(no mission text)'}
      </div>
    </div>
  );
}

function SkillsCard({ agent }: { agent: Agent }): ReactElement {
  const repos = useStore((s) => s.repos);
  const repo = repos.find((r) => r.id === agent.repoId);
  const [skills, setSkills] = useState<string[]>([]);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void window.obelisk
      .invoke('agents:readMd', { repoId: repo.id, agentName: agent.name })
      .then((r) => {
        if (!cancelled && r.ok) setSkills(r.value.skills);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.name, repo?.id]);

  return (
    <div className="settings-card">
      <div className="settings-card-title">Skills loaded</div>
      <div className="settings-card-sub">
        Pulled from <span className="mono">default_skills</span> in the agent.md frontmatter.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {skills.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t-3)' }}>No skills declared.</div>
        ) : (
          skills.map((s) => (
            <div
              key={s}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                background: 'var(--bg-1)',
                border: '1px solid var(--line)',
                borderRadius: 5,
              }}
            >
              <Icon.Code size={11} color="var(--brand-text)" />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t-1)' }}>
                {s}
              </span>
              <div style={{ flex: 1 }} />
              <Icon.Check size={11} color="var(--ok)" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Permissions ───────────────────────── */

function PermissionsCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const items: { key: keyof AgentPermissions; label: string; locked?: boolean }[] = [
    { key: 'readCode', label: 'Read code' },
    { key: 'runTests', label: 'Run tests' },
    { key: 'createIssues', label: 'Create issues' },
    { key: 'draftPrs', label: 'Open draft PRs' },
    { key: 'merge', label: 'Merge', locked: true },
  ];
  return (
    <div className="settings-card">
      <div className="settings-card-title">Permissions</div>
      <div className="settings-card-sub">
        Permissions narrow what this instance is allowed to do. Repo safety mode is the upper bound
        — per-instance toggles can subtract but never add.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {items.map((item) => {
          const on = agent.permissions[item.key];
          return (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle
                on={on}
                disabled={item.locked && !on}
                onClick={() => {
                  if (item.locked && !on) return; // merge stays off
                  void onUpdate({
                    permissions: { ...agent.permissions, [item.key]: !on },
                  });
                }}
              />
              <span style={{ fontSize: 12.5, color: on ? 'var(--t-0)' : 'var(--t-3)' }}>
                {item.label}
              </span>
              {item.locked && !on ? (
                <span className="pill" style={{ fontSize: 10, marginLeft: 'auto' }}>
                  <Icon.Lock size={9} /> safety lvl 4
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({
  on,
  disabled,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      style={{
        width: 28,
        height: 16,
        borderRadius: 8,
        background: on ? 'var(--brand)' : 'var(--bg-3)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 120ms',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: 'white',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transition: 'left 120ms',
        }}
      />
    </button>
  );
}

/* ───────────────────────── Runner & Model ───────────────────────── */

const RUNNER_OPTIONS: RunnerKind[] = ['claude', 'codex'];

const MODEL_OPTIONS: Record<RunnerKind, { id: string; label: string; tier: string }[]> = {
  claude: [
    { id: 'sonnet-4-6', label: 'Sonnet 4.6', tier: 'balanced' },
    { id: 'opus-4-7', label: 'Opus 4.7', tier: 'flagship' },
    { id: 'haiku-4-5', label: 'Haiku 4.5', tier: 'fast' },
  ],
  codex: [
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', tier: 'flagship' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
  ],
};

function RunnerModelCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const runner = agent.runnerOverride ?? 'claude';
  const models = MODEL_OPTIONS[runner];
  const selectedModel = agent.modelOverride ?? models[0]!.id;
  return (
    <div className="settings-card">
      <div className="settings-card-title">Runner &amp; model</div>
      <div className="settings-card-sub">
        Override the repo&rsquo;s default CLI runner and model for this instance only. Model choice
        changes cost / speed; runner choice changes the executable invoked.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Runner
          </div>
          <div className="row gap-2">
            <button
              type="button"
              className={`btn${agent.runnerOverride == null ? ' primary' : ''}`}
              onClick={() => void onUpdate({ runnerOverride: null })}
            >
              Use repo default
            </button>
            {RUNNER_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`btn${agent.runnerOverride === opt ? ' primary' : ''}`}
                onClick={() => void onUpdate({ runnerOverride: opt })}
              >
                {opt === 'claude' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Model
          </div>
          <select
            className="input"
            value={selectedModel}
            onChange={(e) => void onUpdate({ modelOverride: e.target.value })}
            style={{ width: '100%' }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.tier}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Schedule editor ───────────────────────── */

const SCHED_MODES: { id: ScheduleMode; label: string; sub: string; icon: IconName }[] = [
  { id: 'event', label: 'Event-driven', sub: 'react to repo events', icon: 'Branch' },
  { id: 'recurring', label: 'Recurring', sub: 'every N hours / days', icon: 'Clock' },
  { id: 'cron', label: 'Cron', sub: 'cron expression', icon: 'Terminal' },
  { id: 'manual', label: 'Manual only', sub: 'no schedule · run by hand', icon: 'Play' },
];

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every 6 hours', expr: '0 */6 * * *' },
  { label: 'Daily at 02:00', expr: '0 2 * * *' },
  { label: 'Weekdays at 09:00', expr: '0 9 * * 1-5' },
  { label: 'Sundays at 03:00', expr: '0 3 * * 0' },
];

function defaultScheduleConfig(agent: Agent): ScheduleConfig {
  if (agent.schedule) return agent.schedule;
  if (agent.scheduleCron) return { mode: 'cron', cron: agent.scheduleCron };
  return {
    mode: 'recurring',
    every: 1,
    unit: 'hour',
    at: '02:00',
    days: [1, 1, 1, 1, 1, 1, 1],
    tz: 'America/Los_Angeles',
  };
}

function ScheduleEditorCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const initial = useRef<ScheduleConfig>(defaultScheduleConfig(agent));
  const [config, setConfig] = useState<ScheduleConfig>(initial.current);
  useEffect(() => {
    initial.current = defaultScheduleConfig(agent);
    setConfig(initial.current);
  }, [agent.id]);

  const dirty = JSON.stringify(config) !== JSON.stringify(initial.current);
  const summary = describeSchedule(config);
  const next = computeNextRuns(config, 3);
  const eventGated = config.mode === 'event';

  function patch(p: Partial<ScheduleConfig>): void {
    setConfig((prev) => ({ ...prev, ...p }));
  }

  async function save(): Promise<void> {
    if (eventGated) {
      alert(
        'Event-driven scheduling lands with the GitHub webhook ingestor. For now, use Recurring or Cron.',
      );
      return;
    }
    await onUpdate({ schedule: config });
    initial.current = config;
  }

  return (
    <div className="settings-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Icon.Clock size={13} color="var(--t-2)" />
        <span
          style={{
            fontSize: 11,
            color: 'var(--t-2)',
            textTransform: 'uppercase',
            letterSpacing: 0.04,
            fontWeight: 600,
          }}
        >
          Schedule
        </span>
        <span style={{ fontSize: 12, color: 'var(--t-1)' }}>·</span>
        <span style={{ fontSize: 12.5, color: 'var(--t-0)', fontWeight: 500 }}>{summary}</span>
        <div style={{ flex: 1 }} />
        {dirty ? <span className="pill warn">unsaved</span> : null}
        <button
          type="button"
          className="btn ghost sm"
          disabled={!dirty}
          onClick={() => setConfig(initial.current)}
        >
          Reset
        </button>
        <button
          type="button"
          className={`btn primary sm`}
          disabled={!dirty}
          onClick={() => void save()}
        >
          <Icon.Check size={10} /> Save
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px' }}>
        <div style={{ padding: 16, borderRight: '1px solid var(--line)' }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Trigger mode
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 8,
              marginBottom: 18,
            }}
          >
            {SCHED_MODES.map((mode) => {
              const I = Icon[mode.icon];
              const active = config.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => patch({ mode: mode.id })}
                  style={{
                    padding: '10px 8px',
                    borderRadius: 7,
                    cursor: 'pointer',
                    border: `1px solid ${active ? 'var(--brand)' : 'var(--line-strong)'}`,
                    background: active ? 'var(--brand-soft)' : 'var(--bg-1)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    textAlign: 'center',
                  }}
                >
                  <I size={14} color={active ? 'var(--brand-text)' : 'var(--t-2)'} />
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: active ? 'var(--t-0)' : 'var(--t-1)',
                    }}
                  >
                    {mode.label}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--t-3)' }}>{mode.sub}</div>
                </button>
              );
            })}
          </div>

          {config.mode === 'recurring' ? (
            <RecurringConfig config={config} onChange={patch} />
          ) : null}
          {config.mode === 'cron' ? <CronConfig config={config} onChange={patch} /> : null}
          {config.mode === 'manual' ? <ManualConfig agent={agent} /> : null}
          {config.mode === 'event' ? <EventConfig /> : null}
        </div>

        <div
          style={{
            background: 'var(--bg-0)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Next runs
            </div>
            {next.length === 0 ? (
              <div
                style={{
                  padding: 10,
                  borderRadius: 6,
                  background: 'var(--bg-1)',
                  border: '1px dashed var(--line)',
                  fontSize: 11.5,
                  color: 'var(--t-3)',
                  textAlign: 'center',
                }}
              >
                No upcoming runs scheduled
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {next.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: i === 0 ? 'var(--brand-soft)' : 'var(--bg-1)',
                      border: `1px solid ${i === 0 ? 'var(--brand-line)' : 'var(--line)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--t-0)' }}>
                        {r.absolute}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--t-2)' }}>{r.relative}</div>
                    </div>
                    {i === 0 ? (
                      <span className="pill brand" style={{ fontSize: 9.5 }}>
                        next
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Equivalent
            </div>
            <div
              style={{
                padding: 10,
                borderRadius: 6,
                background: 'var(--bg-1)',
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--t-3)', textTransform: 'uppercase' }}>
                cron
              </div>
              <div
                className="mono"
                style={{ fontSize: 11.5, color: 'var(--t-1)', wordBreak: 'break-all' }}
              >
                {config.mode === 'cron'
                  ? (config.cron ?? '—')
                  : config.mode === 'recurring'
                    ? (toCron(config) ?? '—')
                    : '— no schedule —'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecurringConfig({
  config,
  onChange,
}: {
  config: ScheduleConfig;
  onChange: (p: Partial<ScheduleConfig>) => void;
}): ReactElement {
  const days = config.days ?? [1, 1, 1, 1, 1, 1, 1];
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const toggleDay = (i: number): void => {
    const next: [number, number, number, number, number, number, number] = [...days] as typeof days;
    next[i] = next[i] ? 0 : 1;
    onChange({ days: next });
  };
  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>
        Cadence
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--t-1)' }}>Run every</span>
        <input
          type="number"
          min={1}
          max={59}
          value={config.every ?? 1}
          onChange={(e) =>
            onChange({ every: Math.max(1, Math.min(59, Number(e.target.value) || 1)) })
          }
          style={{
            width: 56,
            height: 30,
            padding: '0 8px',
            fontSize: 13,
            fontFamily: 'var(--mono)',
            textAlign: 'center',
            background: 'var(--bg-0)',
            border: '1px solid var(--line-strong)',
            borderRadius: 6,
            color: 'var(--t-0)',
          }}
        />
        <select
          value={config.unit ?? 'hour'}
          onChange={(e) => onChange({ unit: e.target.value as ScheduleConfig['unit'] })}
          style={{
            height: 30,
            padding: '0 10px',
            fontSize: 13,
            background: 'var(--bg-0)',
            border: '1px solid var(--line-strong)',
            borderRadius: 6,
            color: 'var(--t-0)',
          }}
        >
          {(['minute', 'hour', 'day', 'week'] as const).map((u) => (
            <option key={u} value={u}>
              {(config.every ?? 1) === 1 ? u : `${u}s`}
            </option>
          ))}
        </select>
        {(config.unit === 'day' || config.unit === 'week') && (
          <>
            <span style={{ fontSize: 13, color: 'var(--t-1)' }}>at</span>
            <input
              type="time"
              value={config.at ?? '02:00'}
              onChange={(e) => onChange({ at: e.target.value })}
              style={{
                height: 30,
                padding: '0 8px',
                fontSize: 13,
                fontFamily: 'var(--mono)',
                background: 'var(--bg-0)',
                border: '1px solid var(--line-strong)',
                borderRadius: 6,
                color: 'var(--t-0)',
              }}
            />
          </>
        )}
      </div>
      <div className="label" style={{ marginTop: 14, marginBottom: 8 }}>
        Active days
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {dayLabels.map((d, i) => {
          const on = !!days[i];
          return (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(i)}
              style={{
                flex: 1,
                height: 36,
                fontSize: 12,
                fontWeight: 600,
                border: `1px solid ${on ? 'var(--brand)' : 'var(--line-strong)'}`,
                background: on ? 'var(--brand)' : 'var(--bg-0)',
                color: on ? 'white' : 'var(--t-3)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CronConfig({
  config,
  onChange,
}: {
  config: ScheduleConfig;
  onChange: (p: Partial<ScheduleConfig>) => void;
}): ReactElement {
  const expr = config.cron ?? '0 */6 * * *';
  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>
        Common schedules
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {CRON_PRESETS.map((p) => {
          const active = expr === p.expr;
          return (
            <button
              key={p.expr}
              type="button"
              className={`btn ${active ? 'primary' : 'ghost'} sm`}
              onClick={() => onChange({ cron: p.expr })}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="label" style={{ marginBottom: 6 }}>
        Custom expression
      </div>
      <input
        type="text"
        value={expr}
        onChange={(e) => onChange({ cron: e.target.value })}
        spellCheck={false}
        style={{
          width: '100%',
          height: 32,
          padding: '0 10px',
          fontSize: 13,
          fontFamily: 'var(--mono)',
          background: 'var(--bg-0)',
          color: 'var(--t-0)',
          border: '1px solid var(--line-strong)',
          borderRadius: 6,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function ManualConfig({ agent }: { agent: Agent }): ReactElement {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 8,
        background: 'var(--bg-1)',
        border: '1px dashed var(--line-strong)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>No automated schedule</div>
      <div style={{ fontSize: 12, color: 'var(--t-2)', marginTop: 4, lineHeight: 1.5 }}>
        <b style={{ color: 'var(--t-1)' }}>{agent.displayName}</b> only runs when you click{' '}
        <span className="mono">Run now</span>.
      </div>
    </div>
  );
}

function EventConfig(): ReactElement {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 8,
        background: 'var(--bg-1)',
        border: '1px dashed var(--line-strong)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Event-driven</span>
        <span className="pill" style={{ fontSize: 10 }}>
          coming soon
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t-2)', marginTop: 6, lineHeight: 1.5 }}>
        Saves are gated until the GitHub webhook ingestor lands. Use Recurring or Cron in the
        meantime — you can still trigger manually with <span className="mono">Run now</span>.
      </div>
    </div>
  );
}

/* ───────────────────────── Schedule helpers ───────────────────────── */

function describeSchedule(s: ScheduleConfig): string {
  if (s.mode === 'manual') return 'Manual only — no automated runs';
  if (s.mode === 'event') return 'On configured repo events';
  if (s.mode === 'cron') {
    const preset = CRON_PRESETS.find((p) => p.expr === s.cron);
    return preset ? preset.label : `Cron · ${s.cron ?? '—'}`;
  }
  const every = s.every ?? 1;
  const unit = (s.unit ?? 'hour') + (every === 1 ? '' : 's');
  const cadence = every === 1 ? `every ${s.unit ?? 'hour'}` : `every ${every} ${unit}`;
  const days = s.days ?? [1, 1, 1, 1, 1, 1, 1];
  const allDays = days.every((d) => d === 1);
  if (s.unit === 'minute' || s.unit === 'hour') {
    return allDays ? cadence : `${cadence}, ${dayList(days)}`;
  }
  return `${cadence} at ${s.at ?? '00:00'}${allDays ? '' : ', ' + dayList(days)}`;
}

function dayList(days: number[]): string {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (days.slice(0, 5).every((d) => d) && !days[5] && !days[6]) return 'weekdays';
  if (!days.slice(0, 5).some((d) => d) && days[5] && days[6]) return 'weekends';
  return days
    .map((d, i) => (d ? labels[i] : null))
    .filter(Boolean)
    .join(', ');
}

function toCron(s: ScheduleConfig): string | null {
  if (s.mode !== 'recurring') return null;
  const every = s.every ?? 1;
  const at = s.at ?? '00:00';
  const [hStr, mStr] = at.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const days = s.days ?? [1, 1, 1, 1, 1, 1, 1];
  const dows = days.every((d) => d === 1)
    ? '*'
    : days
        .map((d, i) => (d ? (i + 1) % 7 : null))
        .filter((v): v is number => v !== null)
        .join(',');
  if (s.unit === 'minute') return `*/${every} * * * ${dows}`;
  if (s.unit === 'hour') return `0 */${every} * * ${dows}`;
  if (s.unit === 'day') return `${m} ${h} */${every} * *`;
  if (s.unit === 'week') return `${m} ${h} * * ${dows}`;
  return null;
}

function computeNextRuns(
  s: ScheduleConfig,
  count: number,
): { absolute: string; relative: string }[] {
  if (s.mode === 'manual') return [];
  if (s.mode === 'event') {
    return [
      {
        absolute: 'On next matching event',
        relative: `triggers: ${(s.events ?? []).length} configured`,
      },
    ];
  }
  const out: { absolute: string; relative: string }[] = [];
  const now = new Date();
  let cursor = now;
  for (let i = 0; i < count; i++) {
    let next: Date;
    if (s.mode === 'cron') {
      const inc =
        s.cron && s.cron.startsWith('*/15')
          ? 15
          : s.cron === '0 * * * *'
            ? 60
            : s.cron === '0 */6 * * *'
              ? 360
              : s.cron === '0 2 * * *'
                ? 1440
                : 60;
      next = new Date(cursor.getTime() + inc * 60 * 1000);
    } else if (s.unit === 'minute') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 60 * 1000);
    } else if (s.unit === 'hour') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 3600 * 1000);
    } else if (s.unit === 'day') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 86400 * 1000);
      const [h, m] = (s.at ?? '02:00').split(':').map(Number);
      next.setHours(h ?? 0, m ?? 0, 0, 0);
    } else {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 7 * 86400 * 1000);
    }
    cursor = next;
    out.push({ absolute: formatAbsolute(next), relative: formatRelative(next, now) });
  }
  return out;
}

function formatAbsolute(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86400000);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `Today · ${time}`;
  if (isTomorrow) return `Tomorrow · ${time}`;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} · ${time}`;
}

function formatRelative(d: Date, now: Date): string {
  const ms = d.getTime() - now.getTime();
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const dy = Math.floor(h / 24);
  if (dy > 0) return `in ${dy}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m % 60}m`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}

function scheduleSummary(agent: Agent, _meta: AgentMeta): string {
  if (!agent.enabled) return 'paused';
  if (agent.schedule) return describeSchedule(agent.schedule);
  if (agent.scheduleCron) {
    const preset = CRON_PRESETS.find((p) => p.expr === agent.scheduleCron);
    return preset ? preset.label.toLowerCase() : `cron · ${agent.scheduleCron}`;
  }
  return 'default schedule';
}

/* ───────────────────────── History grid ───────────────────────── */

interface HistogramCell {
  dayOfWeek: number;
  hour: number;
  runs: number;
  issues: number;
}

function HistoryGridCard({ agent }: { agent: Agent }): ReactElement {
  const [cells, setCells] = useState<HistogramCell[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.obelisk.invoke('runs:histogram', { agentId: agent.id, hours: 168 }).then((r) => {
      if (!cancelled && r.ok) setCells(r.value.cells);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = cells.reduce((m, c) => Math.max(m, c.runs), 0);
  const lookup = new Map(cells.map((c) => [`${c.dayOfWeek}:${c.hour}`, c]));

  return (
    <div className="settings-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div className="settings-card-title">Run history</div>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--t-3)' }}>
          last 7 days · 168 hours
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 6 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'repeat(7, 1fr)',
            gap: 2,
            fontSize: 10,
            color: 'var(--t-3)',
            fontFamily: 'var(--mono)',
          }}
        >
          {days.map((d) => (
            <div key={d} style={{ display: 'flex', alignItems: 'center' }}>
              {d}
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(24, 1fr)',
            gridTemplateRows: 'repeat(7, 1fr)',
            gap: 2,
          }}
        >
          {Array.from({ length: 7 * 24 }).map((_, idx) => {
            const dow = Math.floor(idx / 24);
            const hour = idx % 24;
            const c = lookup.get(`${dow}:${hour}`);
            const intensity = c && max > 0 ? c.runs / max : 0;
            const bg =
              intensity > 0 ? `oklch(67% 0.17 286 / ${Math.max(0.15, intensity)})` : 'var(--bg-3)';
            const tooltip = c
              ? `${days[dow]} ${String(hour).padStart(2, '0')}:00 — ${c.runs} run${c.runs === 1 ? '' : 's'}`
              : `${days[dow]} ${String(hour).padStart(2, '0')}:00 — idle`;
            const cellStyle: CSSProperties = {
              aspectRatio: '1',
              background: bg,
              borderRadius: 2,
            };
            return <div key={idx} style={cellStyle} title={tooltip} />;
          })}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
          fontSize: 10,
          color: 'var(--t-3)',
        }}
      >
        <span>Less</span>
        {[0.05, 0.25, 0.5, 0.75, 1].map((v) => (
          <span
            key={v}
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: v < 0.1 ? 'var(--bg-3)' : `oklch(67% 0.17 286 / ${v})`,
            }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
