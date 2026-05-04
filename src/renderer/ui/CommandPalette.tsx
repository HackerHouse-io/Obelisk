import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { useStore, type Route } from '../state/store';
import { runAgentByName } from '../state/agent-actions';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  section: 'Navigate' | 'Actions' | 'Settings';
  /** Disabled commands still appear (so users see what's possible) but can't fire. */
  disabled?: boolean;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props): ReactElement | null {
  const repos = useStore((s) => s.repos);
  const setRoute = useStore((s) => s.setRoute);
  const selectedRepoId = useStore((s) => s.selectedRepoId);

  const hasRepo = !!repos.find((r) => r.id === selectedRepoId);

  const commands = useMemo<Command[]>(() => {
    const go = (route: Route) => () => {
      setRoute(route);
      onClose();
    };
    const list: Command[] = [
      { id: 'nav.home', section: 'Navigate', label: 'Home', icon: 'Home', run: go('home') },
      {
        id: 'nav.mission',
        section: 'Navigate',
        label: 'Mission Control',
        icon: 'Pipeline',
        run: go('mission'),
      },
      {
        id: 'nav.backlog',
        section: 'Navigate',
        label: 'Backlog',
        icon: 'Backlog',
        run: go('backlog'),
      },
      {
        id: 'nav.agents',
        section: 'Navigate',
        label: 'Agents',
        icon: 'Agents',
        run: go('agents'),
      },
      {
        id: 'nav.playbook',
        section: 'Navigate',
        label: 'QA Playbook',
        icon: 'Playbook',
        run: go('playbook'),
      },
      {
        id: 'nav.connect',
        section: 'Navigate',
        label: 'Connect Repo',
        icon: 'Connect',
        run: go('connect'),
      },
      {
        id: 'nav.settings',
        section: 'Navigate',
        label: 'Settings',
        icon: 'Settings',
        run: go('settings'),
      },
      {
        id: 'action.run-bug-fixer',
        section: 'Actions',
        label: 'Run Bug Fixer now',
        icon: 'Bug',
        disabled: !hasRepo,
        disabledReason: 'Connect a repo first',
        run: async () => {
          if (!hasRepo) return;
          const res = await runAgentByName(selectedRepoId!, 'bug-fixer');
          if (!res.ok) alert(res.error.message);
          onClose();
        },
      },
      {
        id: 'action.run-qa-hunter',
        section: 'Actions',
        label: 'Run QA Hunter now',
        icon: 'Eye',
        disabled: !hasRepo,
        disabledReason: 'Connect a repo first',
        run: async () => {
          if (!hasRepo) return;
          const res = await runAgentByName(selectedRepoId!, 'qa-hunter');
          if (!res.ok) alert(res.error.message);
          onClose();
        },
      },
      {
        id: 'action.run-feature-builder',
        section: 'Actions',
        label: 'Run Feature Builder now',
        icon: 'Sparkles',
        disabled: !hasRepo,
        disabledReason: 'Connect a repo first',
        run: async () => {
          if (!hasRepo) return;
          const res = await runAgentByName(selectedRepoId!, 'feature-builder');
          if (!res.ok) alert(res.error.message);
          onClose();
        },
      },
      {
        id: 'settings.allowlist',
        section: 'Settings',
        label: 'Manage allowed actors',
        icon: 'Shield',
        run: go('settings'),
      },
      {
        id: 'settings.runner',
        section: 'Settings',
        label: 'Change CLI runner',
        icon: 'Code',
        run: go('settings'),
      },
    ];
    return list;
  }, [hasRepo, onClose, selectedRepoId, setRoute]);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = filtered[activeIdx];
        if (c && !c.disabled) void c.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx, onClose]);

  if (!open) return null;

  const grouped = groupBy(filtered, (c) => c.section);

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <Icon.Search size={14} color="var(--t-2)" />
          <input
            autoFocus
            className="cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or run a command…"
          />
          <span className="kbd cmdk-kbd">esc</span>
        </div>
        <div className="cmdk-results">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">No matching commands.</div>
          ) : (
            (['Navigate', 'Actions', 'Settings'] as const).map((section) => {
              const items = grouped.get(section);
              if (!items?.length) return null;
              return (
                <div key={section} className="cmdk-section">
                  <div className="cmdk-section-title">{section}</div>
                  {items.map((cmd) => {
                    const idxInFiltered = filtered.indexOf(cmd);
                    const active = idxInFiltered === activeIdx;
                    return (
                      <CommandRow
                        key={cmd.id}
                        cmd={cmd}
                        active={active}
                        onClick={() => {
                          if (!cmd.disabled) void cmd.run();
                        }}
                        onMouseEnter={() => setActiveIdx(idxInFiltered)}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function CommandRow({
  cmd,
  active,
  onClick,
  onMouseEnter,
}: {
  cmd: Command;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}): ReactElement {
  const Ico: ((p: { size?: number; color?: string }) => ReactNode) | null = cmd.icon
    ? Icon[cmd.icon]
    : null;
  return (
    <button
      type="button"
      className={`cmdk-row${active ? ' active' : ''}${cmd.disabled ? ' disabled' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      disabled={cmd.disabled}
    >
      <span className="cmdk-row-icon">
        {Ico ? <Ico size={13} color={active ? 'var(--brand-text)' : 'var(--t-2)'} /> : null}
      </span>
      <span className="cmdk-row-label">{cmd.label}</span>
      {cmd.disabled ? <span className="cmdk-row-hint">{cmd.disabledReason}</span> : null}
      {cmd.hint && !cmd.disabled ? <span className="cmdk-row-hint">{cmd.hint}</span> : null}
    </button>
  );
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
