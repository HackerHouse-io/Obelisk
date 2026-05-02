import { useState, type ReactElement } from 'react';

type Route = 'home' | 'mission' | 'backlog' | 'agents' | 'playbook' | 'connect' | 'settings';

const NAV: { id: Route; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'mission', label: 'Mission Control' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'agents', label: 'Agents' },
  { id: 'playbook', label: 'QA Playbook' },
  { id: 'connect', label: 'Connect' },
  { id: 'settings', label: 'Settings' },
];

export function App(): ReactElement {
  const [route, setRoute] = useState<Route>('home');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">Obelisk</div>
          <div className="sidebar-sub">v0.0.1 · scaffolding</div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${route === item.id ? ' active' : ''}`}
              onClick={() => setRoute(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="titlebar">
          <div className="titlebar-text">{NAV.find((n) => n.id === route)?.label}</div>
        </header>
        <section className="screen">
          <div className="placeholder">
            <div className="placeholder-title">{NAV.find((n) => n.id === route)?.label}</div>
            <div className="placeholder-body">
              Phase 0 scaffold. Real screens land in subsequent phases.
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
