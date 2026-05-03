import type { ReactElement } from 'react';
import { Icon, type IconName } from '../icons';
import { useStore, type Route } from '../state/store';
import { ObeliskMark } from './Obelisk';

interface NavRow {
  id: Route;
  label: string;
  icon: IconName;
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

const SAFETY_BAR_COLOR = ['var(--info)', 'var(--brand)', 'var(--warn)', 'var(--bad)'] as const;

const MODE_TO_LEVEL: Record<string, 0 | 1 | 2 | 3> = {
  observe: 0,
  issues: 1,
  prs: 2,
  automerge: 3,
};

export function Sidebar(): ReactElement {
  const route = useStore((s) => s.route);
  const setRoute = useStore((s) => s.setRoute);
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const auth = useStore((s) => s.auth);

  const repo = repos.find((r) => r.id === selectedRepoId);
  const safetyLevel = repo ? (MODE_TO_LEVEL[repo.mode] ?? 0) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-label">Project</div>
        <div className="sidebar-project">
          <ObeliskMark size={12} />
          <div className="sidebar-project-name truncate">
            {repo ? repo.githubFullName : 'No repo connected'}
          </div>
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
              <span className="nav-item-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {safetyLevel !== null ? (
        <div className="sidebar-safety">
          <div className="sidebar-label">Safety level</div>
          <div className="sidebar-safety-bar">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="sidebar-safety-tick"
                style={{
                  background: i <= safetyLevel ? SAFETY_BAR_COLOR[safetyLevel] : 'var(--bg-3)',
                }}
              />
            ))}
          </div>
          <div className="sidebar-safety-name">{SAFETY_LEVELS[safetyLevel].name}</div>
          <div className="sidebar-safety-sub">{SAFETY_LEVELS[safetyLevel].sub}</div>
        </div>
      ) : null}

      <div className="sidebar-user">
        <div className="sidebar-avatar">
          {auth.signedIn && auth.login ? auth.login.slice(0, 2).toUpperCase() : '–'}
        </div>
        <div className="sidebar-user-info">
          <div className="sidebar-user-name truncate">
            {auth.signedIn ? auth.login : 'Not signed in'}
          </div>
          <div className="sidebar-user-sub truncate">
            {auth.signedIn ? 'Connected' : 'Sign in via Connect'}
          </div>
        </div>
      </div>
    </aside>
  );
}
