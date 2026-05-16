import { create } from 'zustand';
import type { Agent, AuthStatus, BacklogItem, Repo, Run, Settings } from '../../shared/types';

export type Route =
  | 'home'
  | 'mission'
  | 'archive'
  | 'backlog'
  | 'agents'
  | 'playbook'
  | 'test-plans'
  | 'coverage'
  | 'qa'
  | 'connect'
  | 'settings';

interface ObeliskState {
  /* navigation */
  route: Route;
  setRoute: (route: Route) => void;

  /* auth */
  auth: AuthStatus;
  setAuth: (auth: AuthStatus) => void;

  /* repos */
  repos: Repo[];
  selectedRepoId: string | null;
  setRepos: (repos: Repo[]) => void;
  selectRepo: (id: string | null) => void;

  /* agents */
  agents: Record<string, Agent[]>; // keyed by repoId
  setAgents: (repoId: string, agents: Agent[]) => void;

  /* runs */
  runs: Record<string, Run>; // keyed by run id
  upsertRun: (run: Run) => void;
  removeRun: (runId: string) => void;
  removeRunsByRepo: (repoId: string, states?: Run['state'][]) => void;

  /* backlog */
  backlog: Record<string, BacklogItem[]>; // keyed by repoId
  setBacklog: (repoId: string, items: BacklogItem[]) => void;

  /* settings */
  settings: Settings | null;
  setSettings: (settings: Settings) => void;

  /* diagnostics */
  lastHeartbeat: string | null;
  setLastHeartbeat: (at: string) => void;
}

export const useStore = create<ObeliskState>((set) => ({
  route: 'home',
  setRoute: (route) => set({ route }),

  auth: { signedIn: false },
  setAuth: (auth) => set({ auth }),

  repos: [],
  selectedRepoId: null,
  setRepos: (repos) =>
    set((s) => ({
      repos,
      selectedRepoId: s.selectedRepoId ?? repos[0]?.id ?? null,
    })),
  selectRepo: (id) => set({ selectedRepoId: id }),

  agents: {},
  setAgents: (repoId, agents) => set((s) => ({ agents: { ...s.agents, [repoId]: agents } })),

  runs: {},
  upsertRun: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: run } })),
  removeRun: (runId) =>
    set((s) => {
      if (!(runId in s.runs)) return s;
      const next = { ...s.runs };
      delete next[runId];
      return { runs: next };
    }),
  removeRunsByRepo: (repoId, states) =>
    set((s) => {
      const next: Record<string, Run> = {};
      for (const [id, run] of Object.entries(s.runs)) {
        if (run.repoId === repoId && (!states || states.includes(run.state))) continue;
        next[id] = run;
      }
      return { runs: next };
    }),

  backlog: {},
  setBacklog: (repoId, items) => set((s) => ({ backlog: { ...s.backlog, [repoId]: items } })),

  settings: null,
  setSettings: (settings) => set({ settings }),

  lastHeartbeat: null,
  setLastHeartbeat: (at) => set({ lastHeartbeat: at }),
}));
