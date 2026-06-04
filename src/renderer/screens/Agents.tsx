import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { Icon, type IconName } from '../icons';
import { useStore } from '../state/store';
import type {
  Agent,
  AgentName,
  AgentPermissions,
  DoctorReport,
  RunnerKind,
  TestPlanSummary,
} from '../../shared/types';
import { EmptyState } from '../ui/EmptyState';
import { SchedulePresetCard } from './agents/SchedulePresetCard';
import { scheduleSummary } from './agents/schedule-helpers';
import { MODEL_OPTIONS, fetchModelsForRunner, tierLabel, type ModelOption } from '../models';
import { showApiAlert } from '../state/alert-store';
import { showConfirm } from '../state/confirm-store';

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
  const [actionError, setActionError] = useState<{ message: string; hint?: string } | null>(null);

  const refresh = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('agents:list', { repoId: repo.id });
    if (res.ok) {
      setAgents(res.value);
      if (res.value.length > 0 && !res.value.find((a) => a.id === selectedAgentId)) {
        // Pick the first agent in canonical AGENTS order (QA Hunter first),
        // not whatever insertion order the DB returned. Falls back to
        // res.value[0] if no canonical match (shouldn't happen with real
        // handlers but keeps the fallback safe).
        const ordered = AGENTS.flatMap((meta) => res.value.filter((a) => a.name === meta.name));
        setSelectedAgentId((ordered[0] ?? res.value[0]!).id);
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

  function reportError(error: { message: string; hint?: string }): void {
    setActionError(error);
  }

  async function createOf(name: AgentName, displayName?: string): Promise<void> {
    setActionError(null);
    const res = await window.obelisk.invoke('agents:create', {
      repoId: repo!.id,
      name,
      ...(displayName ? { displayName } : {}),
    });
    if (!res.ok) {
      reportError(res.error);
      return;
    }
    setSelectedAgentId(res.value.id);
    await refresh();
  }

  async function cloneInstance(agentId: string): Promise<void> {
    setActionError(null);
    const res = await window.obelisk.invoke('agents:clone', { agentId });
    if (!res.ok) {
      reportError(res.error);
      return;
    }
    setSelectedAgentId(res.value.id);
    await refresh();
  }

  async function deleteInstance(agentId: string, displayName: string): Promise<void> {
    const ok = await showConfirm({
      title: `Delete ${displayName}?`,
      body: 'This removes the instance and its scheduling. Run history is kept.',
      confirmLabel: 'Delete',
      confirmIcon: 'Trash',
      tone: 'danger',
    });
    if (!ok) return;
    setActionError(null);
    const res = await window.obelisk.invoke('agents:delete', { agentId });
    if (!res.ok) {
      reportError(res.error);
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
        {actionError ? (
          <div className="agents-list-banner" role="alert">
            <Icon.AlertTri size={12} />
            <div>
              <div className="agents-list-banner-title">{actionError.message}</div>
              {actionError.hint ? (
                <div className="agents-list-banner-hint">{actionError.hint}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn ghost icon"
              onClick={() => setActionError(null)}
              aria-label="Dismiss"
            >
              <Icon.Close size={11} />
            </button>
          </div>
        ) : null}

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
        data-testid={`agent-list-item-${agent.name}`}
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
            {agent.runnerOverride ?? 'default'} · {scheduleSummary(agent)}
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
  const [runStarting, setRunStarting] = useState(false);
  const [runError, setRunError] = useState<{ message: string; hint?: string } | null>(null);

  // Pre-flight: agents that produce patches (bug-fixer, feature-builder)
  // need the repo in `prs` or `automerge` mode — otherwise the publisher
  // rejects every commit/push. Don't even let the user click Run now if
  // we know the run would fail at publish.
  const ownerRepo = useStore((s) => s.repos.find((r) => r.id === agent.repoId));
  const producesPatchAgent = agent.name === 'bug-fixer' || agent.name === 'feature-builder';
  const modeBlocksRun =
    producesPatchAgent && ownerRepo
      ? ownerRepo.mode !== 'prs' && ownerRepo.mode !== 'automerge'
      : false;
  const modeBlockHint = modeBlocksRun
    ? `${meta.label} opens PRs, but this repo is in safety mode "${ownerRepo?.mode}". Switch to "Fix & build" or higher in Settings to enable Run now.`
    : null;

  useEffect(() => {
    setRenameValue(agent.displayName);
  }, [agent.id, agent.displayName]);

  // Reset transient run state when switching agents.
  useEffect(() => {
    setRunStarting(false);
    setRunError(null);
  }, [agent.id]);

  async function update(patch: Partial<Agent>): Promise<void> {
    const res = await window.obelisk.invoke('agents:update', {
      agentId: agent.id,
      patch,
    });
    if (!res.ok) {
      showApiAlert(res.error, 'update agent');
      return;
    }
    // Surface a confirmation toast on the paused → enabled transition and
    // redirect to the Command Center so the user sees the agent in context
    // (with its "Previewing" pill, schedule, and live next-run time).
    if (patch.enabled === true && agent.enabled === false) {
      window.dispatchEvent(
        new CustomEvent('obelisk:agent-enabled', {
          detail: {
            agentId: res.value.id,
            agentName: res.value.name,
            displayName: res.value.displayName,
            nextFireAt: res.value.nextFireAt ?? null,
            scheduleLabel: scheduleSummary(res.value),
            hasSchedule: !!(res.value.scheduleCron ?? res.value.schedule),
          },
        }),
      );
      useStore.getState().setRoute('home');
    }
    await onChanged();
  }

  async function runNow(): Promise<void> {
    if (runStarting) return;
    setRunError(null);
    setRunStarting(true);
    try {
      // Auto mode: preview what the next run would do. If it needs to generate
      // a coverage map and/or a test plan (a multi-minute operation), confirm
      // with the user before kicking off the background prepare-and-run.
      if (agent.planSelectionMode === 'least-covered') {
        const preview = await window.obelisk.invoke('agents:autoPlanPreview', {
          agentId: agent.id,
        });
        if (!preview.ok) {
          setRunError({
            message: preview.error.message,
            ...(preview.error.hint ? { hint: preview.error.hint } : {}),
          });
          setRunStarting(false);
          return;
        }
        const { willGenerateMap, willGeneratePlan, featureLabel } = preview.value;
        if (willGenerateMap || willGeneratePlan) {
          const body = willGenerateMap
            ? 'This repo has no coverage map yet, so this will generate one, then a test plan, then run QA on the least-covered feature. It can take several minutes — progress shows as toasts and the run appears in Mission Control when it starts.'
            : `The least-covered feature${featureLabel ? ` (“${featureLabel}”)` : ''} has no test plan yet, so this will generate one, then run QA on it. It can take several minutes — progress shows as toasts and the run appears in Mission Control when it starts.`;
          const ok = await showConfirm({
            title: 'Prepare and run QA?',
            body,
            confirmLabel: 'Prepare & run',
            confirmIcon: 'Play',
          });
          if (!ok) {
            setRunStarting(false);
            return;
          }
          const prep = await window.obelisk.invoke('agents:autoPrepareAndRun', {
            agentId: agent.id,
          });
          if (!prep.ok) {
            setRunError({
              message: prep.error.message,
              ...(prep.error.hint ? { hint: prep.error.hint } : {}),
            });
            setRunStarting(false);
            return;
          }
          // Generation runs in the background; the drafting toast shows progress
          // and the run appears in Mission Control via runs.changed.
          setRunStarting(false);
          return;
        }
        // No generation needed — fall through to the normal dispatch below,
        // which resolves the same least-covered plan and returns a runId.
      }
      const res = await window.obelisk.invoke('agents:run', { agentId: agent.id });
      if (!res.ok) {
        setRunError({
          message: res.error.message,
          ...(res.error.hint ? { hint: res.error.hint } : {}),
        });
        setRunStarting(false);
        return;
      }
      // Mirror the Test Plans run flow exactly: dispatch the same toast
      // event (RunStartedToast picks it up at the shell), then route to
      // Mission Control. We also forward the claimed taskRef + taskContext
      // (issue#42 + "Crash on cold start") and the repo's full name so the
      // toast can render a clickable GitHub link.
      const ownerRepo =
        useStore.getState().repos.find((r) => r.id === agent.repoId)?.githubFullName ?? null;
      window.dispatchEvent(
        new CustomEvent('obelisk:run-started', {
          detail: {
            runId: res.value.runId,
            agentName: agent.name,
            displayName: agent.displayName,
            taskRef: res.value.taskRef ?? null,
            taskContext: res.value.taskContext ?? null,
            repoFullName: ownerRepo,
          },
        }),
      );
      useStore.getState().setRoute('mission');
      // Component unmounts on route change; no need to clear runStarting.
    } catch (err) {
      setRunError({ message: err instanceof Error ? err.message : 'Failed to start the run.' });
      setRunStarting(false);
    }
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
          <button
            type="button"
            className={`btn primary${runStarting ? ' is-starting' : ''}`}
            onClick={runNow}
            disabled={runStarting || modeBlocksRun}
            aria-busy={runStarting}
            data-testid={`agent-run-now-${agent.name}`}
            title={
              modeBlockHint ??
              (runStarting ? `Starting ${agent.displayName}…` : `Run ${agent.displayName} now`)
            }
          >
            {runStarting ? (
              <>
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
                Starting…
              </>
            ) : (
              <>
                <Icon.Play size={11} /> Run now
              </>
            )}
          </button>
          <button type="button" className="btn ghost" onClick={() => void onDelete()}>
            <Icon.Doc size={11} /> Delete
          </button>
        </div>
      </div>

      {modeBlockHint && !runError ? (
        <div
          className="plan-editor-banner plan-editor-banner-warn"
          role="status"
          data-testid="agent-mode-blocked"
        >
          <Icon.AlertTri size={12} />
          <div>
            <div className="plan-editor-banner-title">Run now is disabled in this safety mode</div>
            <div className="plan-editor-banner-body">{modeBlockHint}</div>
          </div>
        </div>
      ) : null}

      {runError ? (
        <div
          className="plan-editor-banner plan-editor-banner-error"
          role="alert"
          data-testid="agent-run-error"
        >
          <Icon.AlertTri size={12} />
          <div>
            <div className="plan-editor-banner-title">Could not start the run</div>
            <div className="plan-editor-banner-body">{runError.message}</div>
            {runError.hint ? (
              <div className="plan-editor-banner-body" style={{ marginTop: 4, opacity: 0.85 }}>
                {runError.hint}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn ghost icon"
            onClick={() => setRunError(null)}
            aria-label="Dismiss"
          >
            <Icon.Close size={11} />
          </button>
        </div>
      ) : null}

      {agent.name === 'ios-qa-pilot' ? <IosPilotSetupBanner repoId={agent.repoId} /> : null}

      <StatsCard agent={agent} />
      <MissionCard agent={agent} />
      {agent.name === 'bug-fixer' || agent.name === 'feature-builder' ? (
        <BugFixerHealthCard repoId={agent.repoId} />
      ) : null}
      {agent.name === 'qa-hunter' ? (
        <PlanSelectionModeCard agent={agent} onUpdate={update} />
      ) : null}
      {QA_AGENT_NAMES.includes(agent.name) &&
      !(agent.name === 'qa-hunter' && agent.planSelectionMode === 'least-covered') ? (
        <DefaultPlanCard agent={agent} onUpdate={update} />
      ) : null}
      <SkillsCard agent={agent} />
      <SchedulePresetCard agent={agent} onUpdate={update} />
      <PermissionsCard agent={agent} onUpdate={update} />
      <RunnerModelCard agent={agent} onUpdate={update} />
      <HistoryGridCard agent={agent} />
    </div>
  );
}

/* ───────────────────────── iOS Pilot setup banner ───────────────────────── */

function IosPilotSetupBanner({ repoId }: { repoId: string }): ReactElement | null {
  const [report, setReport] = useState<DoctorReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const res = await window.obelisk.invoke('qa:doctor', { repoId });
      if (!cancelled && res.ok) setReport(res.value);
    };
    void refresh();
    const unsubscribe = window.obelisk.subscribe((evt) => {
      if (evt.type === 'qa.doctorChanged' && evt.repoId === repoId) void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [repoId]);

  // While the first doctor probe is in flight, render nothing — flashing a
  // setup-required banner only to retract it a moment later is worse than
  // a brief blank slot.
  if (!report) return null;
  if (report.overall === 'green') return null;

  const failing = report.checks.filter((c) => c.level !== 'green');
  const summary =
    failing.length === 1 ? failing[0]!.label : `${failing.length} checks need attention`;

  return (
    <div
      className="card"
      role="alert"
      style={{
        padding: 14,
        borderColor: 'var(--warn)',
        background: 'var(--warn-soft, var(--bg-1))',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <Icon.AlertTri size={16} color="var(--warn)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          Setup required before this agent can run
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-2)', lineHeight: 1.5 }}>
          iOS QA Pilot needs Appium, the xcuitest driver, and a simulator pool before it can pick
          flows. {summary}.
        </div>
      </div>
      <button
        type="button"
        className="btn primary sm"
        onClick={() => useStore.getState().setRoute('qa')}
      >
        Open iOS Pilot setup <Icon.ArrowRight size={11} />
      </button>
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

function BugFixerHealthCard({ repoId }: { repoId: string }): ReactElement {
  const [data, setData] = useState<import('../../shared/types').BugFixerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.obelisk.invoke('bugFixer:health', { repoId });
    if (res.ok) {
      setData(res.value);
      setError(null);
    } else {
      setError(res.error.message);
    }
  }, [repoId]);

  useEffect(() => {
    void refresh();
    // Repaint on any run transition so the counts feel live.
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'run.transition' || evt.type === 'run.created') {
        void refresh();
      }
    });
  }, [refresh]);

  if (error) {
    return (
      <div className="settings-card">
        <div className="settings-card-title">Health (last 7 days)</div>
        <div className="settings-card-sub">Couldn’t load: {error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="settings-card">
        <div className="settings-card-title">Health (last 7 days)</div>
        <div className="settings-card-sub">Loading…</div>
      </div>
    );
  }

  return (
    <div className="settings-card" data-testid="bug-fixer-health-card">
      <div className="settings-card-title">Health (last 7 days)</div>
      <div className="settings-card-sub">
        Aggregated from the audit log. Helps you spot rebase storms, scope blowups, and
        sibling-installation collisions before they pile up.
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 10,
          marginTop: 10,
        }}
      >
        <HealthMetric
          label="PRs opened"
          value={data.prsOpened}
          tone={data.prsOpened > 0 ? 'ok' : 'neutral'}
          testId="health-prs-opened"
        />
        <HealthMetric
          label="Runs done"
          value={data.runsDone}
          tone={data.runsDone > 0 ? 'ok' : 'neutral'}
          testId="health-runs-done"
        />
        <HealthMetric
          label="Runs failed"
          value={data.runsFailed}
          tone={data.runsFailed > 0 ? 'warn' : 'neutral'}
          testId="health-runs-failed"
        />
        <HealthMetric
          label="Rebases ok / conflict"
          value={`${data.rebaseSuccess} / ${data.rebaseConflict}`}
          tone={data.rebaseConflict > 0 ? 'warn' : 'neutral'}
          testId="health-rebases"
        />
        <HealthMetric
          label="CI retry ok / failed"
          value={`${data.ciRetrySuccess} / ${data.ciRetryFailed}`}
          tone={data.ciRetryFailed > 0 ? 'warn' : 'neutral'}
          testId="health-ci-retry"
        />
        <HealthMetric
          label="Escalations"
          value={data.rebaseEscalated + data.ciRetryEscalated}
          tone={data.rebaseEscalated + data.ciRetryEscalated > 0 ? 'bad' : 'neutral'}
          testId="health-escalations"
        />
        <HealthMetric
          label="Cross-install skips"
          value={data.crossInstallSkipped}
          tone="neutral"
          testId="health-cross-install"
        />
        <HealthMetric
          label="Stale signals reaped"
          value={data.claimSignalReaped}
          tone="neutral"
          testId="health-reaped"
        />
      </div>
    </div>
  );
}

function HealthMetric({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string | number;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  testId: string;
}): ReactElement {
  const color =
    tone === 'ok'
      ? 'var(--ok)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'bad'
          ? 'var(--bad)'
          : 'var(--t-1)';
  return (
    <div
      data-testid={testId}
      style={{
        background: 'var(--bg-0)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        padding: '8px 10px',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--t-2)', marginTop: 2 }}>{label}</div>
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

/* ───────────────────────── Default test plan ───────────────────────── */

const QA_AGENT_NAMES: AgentName[] = ['qa-hunter', 'manual-qa', 'ios-qa-pilot'];

function PlanSelectionModeCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const mode = agent.planSelectionMode ?? 'fixed';
  const options: { id: 'fixed' | 'least-covered'; label: string; sub: string; icon: IconName }[] = [
    {
      id: 'fixed',
      label: 'Fixed plan',
      sub: 'always run the chosen default test plan',
      icon: 'Doc',
    },
    {
      id: 'least-covered',
      label: 'Least-covered (auto)',
      sub: 'each run, target the weakest feature — generate its plan if missing',
      icon: 'Spark',
    },
  ];
  return (
    <div className="settings-card">
      <div className="settings-card-title">Plan selection</div>
      <div className="settings-card-sub">
        How this Bug Hunter chooses what to test on each run. <em>Least-covered</em> shifts
        attention to whichever feature has the lowest coverage, generating a coverage map and/or
        test plan for it first when none exists — so it keeps maintaining the whole repo instead of
        one fixed plan.
      </div>
      <div className="col" style={{ gap: 8, marginTop: 10 }}>
        {options.map((o) => {
          const IconCmp = Icon[o.icon];
          const active = mode === o.id;
          return (
            <button
              key={o.id}
              type="button"
              data-testid={`agent-plan-mode-${o.id}`}
              aria-pressed={active}
              onClick={() => {
                if (!active) void onUpdate({ planSelectionMode: o.id });
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 8,
                cursor: active ? 'default' : 'pointer',
                color: 'var(--t-0)',
                border: `1px solid ${active ? 'var(--brand)' : 'var(--border, var(--bg-3))'}`,
                background: active ? 'var(--brand-soft, var(--bg-1))' : 'transparent',
              }}
            >
              <IconCmp size={15} color={active ? 'var(--brand)' : 'var(--t-2)'} />
              <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
                <span style={{ fontWeight: 600 }}>{o.label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--t-2)' }}>{o.sub}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DefaultPlanCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const [plans, setPlans] = useState<TestPlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.obelisk.invoke('testPlans:list', {
      repoId: agent.repoId,
      agentName: agent.name,
    });
    setLoading(false);
    if (res.ok) {
      setPlans(res.value);
      setError(null);
    } else {
      setError(res.error.message);
    }
  }, [agent.repoId, agent.name]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.obelisk.subscribe((evt) => {
      if (evt.type === 'testPlans.changed' && evt.repoId === agent.repoId) void refresh();
    });
    return unsubscribe;
  }, [refresh, agent.repoId]);

  // If the saved default no longer applies to this agent (plan deleted, or
  // the user removed this agent from the plan's agentNames), drop it from
  // the agent record so the dropdown doesn't display a stale id.
  useEffect(() => {
    if (loading || !agent.defaultPlanId) return;
    if (!plans.some((p) => p.id === agent.defaultPlanId)) {
      void onUpdate({ defaultPlanId: null });
    }
  }, [loading, plans, agent.defaultPlanId, onUpdate]);

  // Auto-pick the first available plan as the default so the user doesn't
  // have to make an explicit assignment to dispatch. We track per-agent
  // whether we've already auto-picked so that explicitly choosing
  // "— No default —" later sticks (it would otherwise re-fire).
  const autoPickedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (loading) return;
    if (agent.defaultPlanId) return;
    if (plans.length === 0) return;
    if (autoPickedRef.current.has(agent.id)) return;
    autoPickedRef.current.add(agent.id);
    void onUpdate({ defaultPlanId: plans[0]!.id });
  }, [loading, plans, agent.defaultPlanId, agent.id, onUpdate]);

  const value =
    agent.defaultPlanId && plans.some((p) => p.id === agent.defaultPlanId)
      ? agent.defaultPlanId
      : '';

  async function onChange(next: string): Promise<void> {
    await onUpdate({ defaultPlanId: next || null });
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title">Default test plan</div>
      <div className="settings-card-sub">
        Pick a plan to run automatically when you click <em>Run now</em> or when this agent fires on
        a schedule. You can still pick a different plan ad-hoc from the Test Plans screen.
      </div>
      <div style={{ marginTop: 10 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--t-3)' }}>Loading plans…</div>
        ) : plans.length === 0 ? (
          <div className="col" style={{ gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--t-2)' }}>
              No test plans target this agent yet.
            </div>
            <div className="row gap-2">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => useStore.getState().setRoute('test-plans')}
              >
                Open Test Plans
              </button>
            </div>
          </div>
        ) : (
          <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              data-testid={`agent-default-plan-${agent.name}`}
              className="file-issue-input"
              value={value}
              onChange={(e) => void onChange(e.target.value)}
              style={{ minWidth: 240 }}
            >
              <option value="">— No default (pick at run time) —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.caseCount} case{p.caseCount === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => useStore.getState().setRoute('test-plans')}
              title="Edit or create plans"
            >
              Manage plans
            </button>
          </div>
        )}
        {error ? (
          <div style={{ fontSize: 12, color: 'var(--bad)', marginTop: 6 }}>{error}</div>
        ) : null}
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
    { key: 'draftPrs', label: 'Open PRs' },
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

function RunnerModelCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const runner = agent.runnerOverride ?? 'claude';
  // Models are dynamic: read from the user's CLI config + Anthropic/OpenAI
  // /v1/models when an API key is set. Curated MODEL_OPTIONS is the
  // first-paint fallback and protects against a missing IPC handler.
  const [models, setModels] = useState<ModelOption[]>(MODEL_OPTIONS[runner]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void fetchModelsForRunner(runner).then((res) => {
      if (!alive) return;
      setModels(res.models);
      setDefaultModelId(res.defaultModelId);
    });
    return () => {
      alive = false;
    };
  }, [runner, refreshTick]);
  // Self-heal stale modelOverride: if the persisted value isn't a valid
  // model for the current runner (e.g. user picked a Claude model, then
  // switched to Codex — the DB still holds the Claude id while the
  // dropdown silently displays the first Codex option), reset to null so
  // the displayed default actually matches what runs use. Without this,
  // "Run now" would pass the stale Claude id to the Codex CLI and fail
  // with "model X is not supported when using Codex".
  useEffect(() => {
    if (agent.modelOverride == null) return;
    if (models.length === 0) return;
    if (models.some((m) => m.id === agent.modelOverride)) return;
    void onUpdate({ modelOverride: null });
  }, [agent.modelOverride, models, onUpdate]);
  const selectedModel = agent.modelOverride ?? defaultModelId ?? models[0]!.id;
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
              onClick={() => void onUpdate({ runnerOverride: null, modelOverride: null })}
            >
              Use repo default
            </button>
            {RUNNER_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`btn${agent.runnerOverride === opt ? ' primary' : ''}`}
                onClick={() => {
                  // Clear modelOverride when the runner changes — model
                  // namespaces don't overlap between Claude and Codex, so
                  // carrying over the prior runner's id silently breaks
                  // the next run.
                  if (agent.runnerOverride !== opt) {
                    void onUpdate({ runnerOverride: opt, modelOverride: null });
                  } else {
                    void onUpdate({ runnerOverride: opt });
                  }
                }}
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
          <div className="row gap-2" style={{ alignItems: 'stretch' }}>
            <select
              className="input"
              value={selectedModel}
              onChange={(e) => void onUpdate({ modelOverride: e.target.value })}
              style={{ flex: 1 }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {tierLabel(m.tier)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setRefreshTick((t) => t + 1)}
              title="Refresh model list (re-reads CLI config + live API)"
              aria-label="Refresh model list"
            >
              ↻
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
