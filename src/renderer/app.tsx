import { useEffect, type ReactElement } from 'react';
import { Shell } from './shell/Shell';
import { useStore, type Route } from './state/store';
import { startBusSubscriber } from './state/bus-subscriber';
import { Connect } from './screens/Connect';
import { Home } from './screens/Home';
import { MissionControl } from './screens/MissionControl';
import { Backlog } from './screens/Backlog';

export function App(): ReactElement {
  const route = useStore((s) => s.route);
  const setRoute = useStore((s) => s.setRoute);
  const setSettings = useStore((s) => s.setSettings);
  const setRepos = useStore((s) => s.setRepos);
  const setAuth = useStore((s) => s.setAuth);

  useEffect(() => {
    const unsubscribe = startBusSubscriber();

    void (async () => {
      const [settingsRes, reposRes, authRes] = await Promise.all([
        window.obelisk.invoke('settings:get', undefined),
        window.obelisk.invoke('repos:list', undefined),
        window.obelisk.invoke('auth:status', undefined),
      ]);
      if (settingsRes.ok) setSettings(settingsRes.value);
      if (authRes.ok) setAuth(authRes.value);
      if (reposRes.ok) {
        setRepos(reposRes.value);
        // First launch: no repos connected → drop the user into the wizard.
        if (reposRes.value.length === 0) setRoute('connect');
      }
    })();

    return unsubscribe;
  }, [setSettings, setRepos, setAuth, setRoute]);

  return <Shell>{renderScreen(route)}</Shell>;
}

const TITLES: Record<Route, string> = {
  home: 'Project Command Center',
  mission: 'Mission Control',
  backlog: 'Backlog',
  agents: 'Agents',
  playbook: 'QA Playbook',
  connect: 'Connect Repo',
  settings: 'Settings',
};

const SUBTITLES: Record<Route, string> = {
  home: 'Repo health at a glance. Lands in Phase 4.',
  mission: 'Live pipeline + audit drawer. Lands in Phase 4.',
  backlog: 'Drag-to-rank queue. Lands in Phase 5.',
  agents: 'Marketplace + per-agent detail. Lands in Phase 9.',
  playbook: 'qa/ editor. Lands in Phase 9.',
  connect: '',
  settings: 'Safety modes, runners, allowed actors. Lands in Phase 9.',
};

function renderScreen(route: Route): ReactElement {
  if (route === 'connect') return <Connect />;
  if (route === 'home') return <Home />;
  if (route === 'mission') return <MissionControl />;
  if (route === 'backlog') return <Backlog />;
  return (
    <div className="placeholder">
      <div className="placeholder-title">{TITLES[route]}</div>
      <div className="placeholder-body">{SUBTITLES[route]}</div>
    </div>
  );
}
