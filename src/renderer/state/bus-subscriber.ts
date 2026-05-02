import type { BusEvent } from '../../shared/types';
import { useStore } from './store';

/**
 * Wires the main → renderer bus into the Zustand store.
 * Returns a teardown function so React effects can clean up.
 */
export function startBusSubscriber(): () => void {
  return window.obelisk.subscribe((event: BusEvent) => {
    const state = useStore.getState();

    switch (event.type) {
      case 'system.heartbeat':
        state.setLastHeartbeat(event.at);
        return;

      case 'auth.changed':
        state.setAuth({ signedIn: event.signedIn });
        return;

      case 'run.created':
        state.upsertRun(event.run);
        return;

      case 'run.transition': {
        const existing = state.runs[event.runId];
        if (!existing) return;
        state.upsertRun({ ...existing, state: event.state });
        return;
      }

      case 'run.audit':
        // Phase 4 wires this into Mission Control's audit drawer.
        return;

      case 'backlog.changed':
      case 'evidence.missing':
        // Phase 4-5 will refetch the affected slice.
        return;
    }
  });
}
