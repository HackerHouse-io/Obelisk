import type { CSSProperties, ReactElement } from 'react';
import { Icon, type IconName } from '../icons';
import { useStore, type Route } from '../state/store';
import { ObeliskMark } from './Obelisk';

interface NavRow {
  id: Route;
  label: string;
  icon: IconName;
  live?: boolean;
  count?: number;
}

const NAV: NavRow[] = [
  { id: 'home', label: 'Command Center', icon: 'Home' },
  { id: 'mission', label: 'Mission Control', icon: 'Pipeline' },
  { id: 'backlog', label: 'Backlog', icon: 'Backlog' },
  { id: 'agents', label: 'Agents', icon: 'Agents' },
  { id: 'playbook', label: 'QA Playbook', icon: 'Playbook' },
  { id: 'connect', label: 'Connect Repo', icon: 'Connect' },
  { id: 'settings', label: 'Settings', icon: 'Settings' },
];

const SAFETY_LEVELS = [
  { name: 'Observe only', sub: 'Dry run · no writes' },
  { name: 'File issues', sub: 'Issues + Playbook PR' },
  { name: 'Fix & build', sub: 'Draft PRs allowed' },
  { name: 'Auto-merge', sub: 'Safe fixes auto-merge' },
] as const;

const SAFETY_COLORS = ['var(--info)', 'var(--brand)', 'var(--warn)', 'var(--bad)'] as const;

export function Sidebar(): ReactElement {
  const route = useStore((s) => s.route);
  const setRoute = useStore((s) => s.setRoute);
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const auth = useStore((s) => s.auth);

  const repo = repos.find((r) => r.id === selectedRepoId);
  // Phase 1: defaults until Connect wizard runs.
  const safetyLevel: 0 | 1 | 2 | 3 = 0;
  const activeRunsCount: number = 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-header" style={{ paddingTop: 14 }}>
        <div className="label" style={{ fontSize: 10 }}>
          Project
        </div>
        <div className="row gap-2 mt-1">
          <ObeliskMark size={12} />
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {repo ? repo.githubFullName : 'No repo connected'}
          </div>
        </div>
        <div className="row gap-2 mt-2" style={{ fontSize: 11, color: 'var(--t-2)' }}>
          <span className="dot live" style={{ background: 'var(--ok)', color: 'var(--ok)' }} />
          {activeRunsCount} active {activeRunsCount === 1 ? 'run' : 'runs'}
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((item) => {
          const IconCmp = Icon[item.icon];
          const active = route === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item${active ? ' active' : ''}`}
              onClick={() => setRoute(item.id)}
            >
              <IconCmp size={14} color={active ? 'var(--brand-text)' : 'var(--t-2)'} />
              <span className="flex-1" style={{ textAlign: 'left' }}>
                {item.label}
              </span>
              {item.live ? (
                <span
                  className="dot live"
                  style={{ background: 'var(--ok)', color: 'var(--ok)' }}
                />
              ) : null}
              {item.count != null ? (
                <span style={{ fontSize: 10.5, color: 'var(--t-2)' }} className="tab-num">
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div style={{ padding: 12, borderTop: '1px solid var(--line-soft)' }}>
        <div className="label" style={{ fontSize: 10 }}>
          Safety level
        </div>
        <SafetyMeter level={safetyLevel} />
        <div style={{ fontSize: 11.5, color: 'var(--t-1)', marginTop: 6 }}>
          {SAFETY_LEVELS[safetyLevel].name}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--t-2)', marginTop: 2 }}>
          {SAFETY_LEVELS[safetyLevel].sub}
        </div>
      </div>

      <div className="sidebar-footer" style={userBoxStyle}>
        <div style={avatarStyle}>{(auth.login ?? '?').slice(0, 2).toUpperCase()}</div>
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontSize: 12, fontWeight: 600 }}>
            {auth.signedIn ? auth.login : 'Not signed in'}
          </div>
          <div className="truncate" style={{ fontSize: 10.5, color: 'var(--t-2)' }}>
            {auth.signedIn ? 'Connected · v0.0.1' : 'Sign in via Connect'}
          </div>
        </div>
      </div>
    </aside>
  );
}

function SafetyMeter({ level }: { level: 0 | 1 | 2 | 3 }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: i <= level ? SAFETY_COLORS[level] : 'var(--bg-3)',
          }}
        />
      ))}
    </div>
  );
}

const userBoxStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
};

const avatarStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: '50%',
  background: 'linear-gradient(135deg, oklch(70% 0.14 320), oklch(60% 0.16 250))',
  fontSize: 10,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'white',
};
