import { useEffect, type ReactElement } from 'react';
import { Shell } from './shell/Shell';
import { useStore, type Route } from './state/store';
import { startBusSubscriber } from './state/bus-subscriber';
import { Connect } from './screens/Connect';
import { Home } from './screens/Home';
import { MissionControl } from './screens/MissionControl';
import { Backlog } from './screens/Backlog';
import { AgentsScreen } from './screens/Agents';
import { Playbook } from './screens/Playbook';
import { TestPlans } from './screens/TestPlans';
import { Coverage } from './screens/Coverage';
import { Qa } from './screens/Qa';
import { SettingsScreen } from './screens/Settings';

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

function renderScreen(route: Route): ReactElement {
  switch (route) {
    case 'connect':
      return <Connect />;
    case 'home':
      return <Home />;
    case 'mission':
      return <MissionControl />;
    case 'backlog':
      return <Backlog />;
    case 'agents':
      return <AgentsScreen />;
    case 'playbook':
      return <Playbook />;
    case 'test-plans':
      return <TestPlans />;
    case 'coverage':
      return <Coverage />;
    case 'qa':
      return <Qa />;
    case 'settings':
      return <SettingsScreen />;
  }
}
