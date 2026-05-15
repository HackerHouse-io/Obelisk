import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { Icon, type IconName } from '../../icons';
import { useStore } from '../../state/store';
import { showAlert } from '../../state/alert-store';
import type { Agent, ScheduleConfig, ScheduleMode } from '../../../shared/types';
import {
  CRON_PRESETS,
  PRESETS,
  computeNextRuns,
  defaultScheduleConfig,
  describeSchedule,
  formatNextFireRelative,
  matchPreset,
  presetToConfig,
  toCron,
  type PresetId,
} from './schedule-helpers';

const SAVE_DEBOUNCE_MS = 350;

const SCHED_MODES: { id: ScheduleMode; label: string; sub: string; icon: IconName }[] = [
  { id: 'event', label: 'Event-driven', sub: 'react to repo events', icon: 'Branch' },
  { id: 'recurring', label: 'Recurring', sub: 'every N hours / days', icon: 'Clock' },
  { id: 'cron', label: 'Cron', sub: 'cron expression', icon: 'Terminal' },
  { id: 'manual', label: 'Manual only', sub: 'no schedule · run by hand', icon: 'Play' },
];

export function SchedulePresetCard({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => Promise<void>;
}): ReactElement {
  const baseConfig = useMemo(
    () => defaultScheduleConfig(agent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.id, agent.schedule, agent.scheduleCron],
  );

  // Overlay holds the pending optimistic config from a chip click while the
  // debounced IPC is in flight. The displayed config is `overlay ?? baseConfig`.
  const [overlay, setOverlay] = useState<ScheduleConfig | null>(null);
  const [customDraft, setCustomDraft] = useState<ScheduleConfig>(baseConfig);
  const [customOpen, setCustomOpen] = useState<boolean>(matchPreset(baseConfig) === null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastHeartbeat = useStore((s) => s.lastHeartbeat);

  // Reset all local state when the user switches agents. We intentionally key
  // off `agent.id` only — re-running this on every prop change of `agent`
  // would clobber unsaved Custom edits as soon as a heartbeat refreshed.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setOverlay(null);
    const fresh = defaultScheduleConfig(agent);
    setCustomDraft(fresh);
    setCustomOpen(matchPreset(fresh) === null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Re-sync the Custom draft when the saved schedule on the agent changes
  // from outside (after a successful save settles or after an external IPC).
  useEffect(() => {
    setCustomDraft(defaultScheduleConfig(agent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.schedule, agent.scheduleCron]);

  // Cleanup: cancel pending IPC if the card unmounts.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const displayed = overlay ?? baseConfig;
  const activePreset: PresetId | null = matchPreset(displayed);
  const summary = describeSchedule(displayed);

  // Live "Next: in 4m 12s" pill ticked off the existing heartbeat broadcast.
  // No setInterval — the bus heartbeat updates `lastHeartbeat` in the store
  // every ~30 s and triggers this re-render for free.
  const nextRelative = useMemo(() => {
    if (!agent.enabled) return null;
    return formatNextFireRelative(agent.nextFireAt, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.enabled, agent.nextFireAt, lastHeartbeat]);

  const applyPreset = useCallback(
    (id: PresetId): void => {
      const next = presetToConfig(id, displayed);
      setOverlay(next);
      setCustomDraft(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void onUpdate({ schedule: next }).finally(() => {
          setOverlay(null);
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [displayed, onUpdate],
  );

  const presetOrder: (PresetId | 'custom')[] = [...PRESETS.map((p) => p.id), 'custom'];

  function focusChip(idx: number): void {
    const target = chipRefs.current[(idx + presetOrder.length) % presetOrder.length];
    target?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number): void {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusChip(idx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusChip(idx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusChip(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusChip(presetOrder.length - 1);
    }
  }

  return (
    <div className="settings-card sched-card">
      <div className="sched-card-titlerow">
        <div>
          <div className="settings-card-title">Schedule</div>
          <div className="settings-card-sub">How often this agent runs on its own. {summary}.</div>
        </div>
        <span
          className={`pill${agent.enabled && nextRelative ? ' brand' : ''} sched-next-pill`}
          aria-live="polite"
        >
          {agent.enabled
            ? nextRelative
              ? `Next ${nextRelative}`
              : 'No next run'
            : `Paused — ${summary.toLowerCase()}`}
        </span>
      </div>

      <div className="sched-card-body">
        {!agent.enabled ? (
          <div className="sched-paused-note">
            This agent is paused — scheduled runs won&rsquo;t fire until you click <b>Enable</b> in
            the header. <span className="mono">Run now</span> still works.
          </div>
        ) : null}

        <div
          className="sched-chips"
          role="radiogroup"
          aria-label="Schedule preset"
          onKeyDown={(e) => {
            // Delegated handling; individual chips also have onKeyDown for clarity.
            void e;
          }}
        >
          {PRESETS.map((p, idx) => {
            const isActive = activePreset === p.id && !customOpen;
            return (
              <button
                key={p.id}
                ref={(el) => {
                  chipRefs.current[idx] = el;
                }}
                type="button"
                role="radio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`sched-chip${isActive ? ' active' : ''}`}
                onClick={() => {
                  setCustomOpen(false);
                  applyPreset(p.id);
                }}
                onKeyDown={(e) => onChipKeyDown(e, idx)}
              >
                {p.label}
              </button>
            );
          })}
          <button
            ref={(el) => {
              chipRefs.current[PRESETS.length] = el;
            }}
            type="button"
            className={`sched-chip${customOpen ? ' active' : ''}`}
            aria-expanded={customOpen}
            aria-controls={`sched-custom-${agent.id}`}
            tabIndex={customOpen || activePreset === null ? 0 : -1}
            onClick={() => setCustomOpen((v) => !v)}
            onKeyDown={(e) => onChipKeyDown(e, PRESETS.length)}
          >
            Custom
            <Icon.ChevronDown
              size={10}
              style={{
                transform: customOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform 120ms var(--ease)',
                marginLeft: 4,
              }}
            />
          </button>
        </div>

        {customOpen ? (
          <CustomEditor
            id={`sched-custom-${agent.id}`}
            agent={agent}
            draft={customDraft}
            onDraftChange={setCustomDraft}
            onSave={async (next) => {
              await onUpdate({ schedule: next });
            }}
            onReset={() => setCustomDraft(baseConfig)}
            baseConfig={baseConfig}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ───────────────────────── Custom editor (advanced) ───────────────────────── */

function CustomEditor({
  id,
  agent,
  draft,
  onDraftChange,
  onSave,
  onReset,
  baseConfig,
}: {
  id: string;
  agent: Agent;
  draft: ScheduleConfig;
  onDraftChange: (next: ScheduleConfig) => void;
  onSave: (next: ScheduleConfig) => Promise<void>;
  onReset: () => void;
  baseConfig: ScheduleConfig;
}): ReactElement {
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseConfig);
  const next = computeNextRuns(draft, 3);
  const eventGated = draft.mode === 'event';

  function patch(p: Partial<ScheduleConfig>): void {
    onDraftChange({ ...draft, ...p });
  }

  async function save(): Promise<void> {
    if (eventGated) {
      showAlert({
        title: 'Event-driven scheduling not available yet',
        body: 'It lands with the GitHub webhook ingestor. For now, use Recurring or Cron.',
      });
      return;
    }
    await onSave(draft);
  }

  return (
    <div id={id} className="sched-custom">
      <div className="sched-custom-toolbar">
        {dirty ? <span className="pill warn">unsaved</span> : null}
        <button type="button" className="btn ghost sm" disabled={!dirty} onClick={onReset}>
          Reset
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={!dirty}
          onClick={() => void save()}
        >
          <Icon.Check size={10} /> Save
        </button>
      </div>

      <div className="sched-custom-grid">
        <div className="sched-custom-main">
          <div className="label" style={{ marginBottom: 8 }}>
            Trigger mode
          </div>
          <div className="sched-mode-grid">
            {SCHED_MODES.map((mode) => {
              const I = Icon[mode.icon];
              const active = draft.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  className={`sched-mode${active ? ' active' : ''}`}
                  onClick={() => patch({ mode: mode.id })}
                >
                  <I size={14} color={active ? 'var(--brand-text)' : 'var(--t-2)'} />
                  <div className="sched-mode-label">{mode.label}</div>
                  <div className="sched-mode-sub">{mode.sub}</div>
                </button>
              );
            })}
          </div>

          {draft.mode === 'recurring' ? <RecurringConfig config={draft} onChange={patch} /> : null}
          {draft.mode === 'cron' ? <CronConfig config={draft} onChange={patch} /> : null}
          {draft.mode === 'manual' ? <ManualConfig agent={agent} /> : null}
          {draft.mode === 'event' ? <EventConfig /> : null}
        </div>

        <div className="sched-custom-side">
          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Next runs
            </div>
            {next.length === 0 ? (
              <div className="sched-side-empty">No upcoming runs scheduled</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {next.map((r, i) => (
                  <div key={i} className={`sched-side-run${i === 0 ? ' first' : ''}`}>
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
            <div className="sched-side-cron">
              <div style={{ fontSize: 10, color: 'var(--t-3)', textTransform: 'uppercase' }}>
                cron
              </div>
              <div
                className="mono"
                style={{ fontSize: 11.5, color: 'var(--t-1)', wordBreak: 'break-all' }}
              >
                {draft.mode === 'cron'
                  ? (draft.cron ?? '—')
                  : draft.mode === 'recurring'
                    ? (toCron(draft) ?? '—')
                    : '— no schedule —'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Mode-specific subforms (lifted from Agents.tsx) ───────────────────────── */

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
            <span style={{ fontSize: 11, color: 'var(--t-3)' }}>UTC</span>
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
      <div style={{ fontSize: 11, color: 'var(--t-3)', marginTop: 6 }}>
        Expressions are evaluated in UTC.
      </div>
    </div>
  );
}

function ManualConfig({ agent }: { agent: Agent }): ReactElement {
  return (
    <div className="sched-callout">
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
    <div className="sched-callout">
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
