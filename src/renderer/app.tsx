import { useEffect, type ReactElement } from 'react';
import { Shell } from './shell/Shell';
import { useStore, type Route } from './state/store';
import { startBusSubscriber } from './state/bus-subscriber';

export function App(): ReactElement {
  const route = useStore((s) => s.route);
  const setSettings = useStore((s) => s.setSettings);

  useEffect(() => {
    const unsubscribe = startBusSubscriber();
    void window.obelisk.invoke('settings:get', undefined).then((res) => {
      if (res.ok) setSettings(res.value);
    });
    return unsubscribe;
  }, [setSettings]);

  return (
    <Shell>
      <Placeholder route={route} />
    </Shell>
  );
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
  connect: 'OAuth Device Flow + 6-step wizard. Lands in Phase 2.',
  settings: 'Safety modes, runners, allowed actors. Lands in Phase 9.',
};

function Placeholder({ route }: { route: Route }): ReactElement {
  return (
    <div className="placeholder">
      <div className="placeholder-title">{TITLES[route]}</div>
      <div className="placeholder-body">{SUBTITLES[route]}</div>
    </div>
  );
}
