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
        const isTerminal =
          event.state === 'done' || event.state === 'failed' || event.state === 'cancelled';
        state.upsertRun({
          ...existing,
          state: event.state,
          // Stamp finishedAt off the event when the run reaches a terminal
          // state — otherwise "Done today" / time-elapsed indicators stay
          // stale until the user navigates away and back.
          finishedAt: isTerminal ? (existing.finishedAt ?? event.at) : existing.finishedAt,
        });
        return;
      }

      case 'run.audit':
        // Phase 4 wires this into Mission Control's audit drawer.
        return;

      case 'run.deleted':
        state.removeRun(event.runId);
        return;

      case 'backlog.changed':
      case 'evidence.missing':
        // Phase 4-5 will refetch the affected slice.
        return;

      case 'agent.autoPaused':
        // Re-broadcast as a window event so the AutoPauseToast (mounted at
        // the shell) can render without subscribing to the IPC bus directly.
        window.dispatchEvent(new CustomEvent('obelisk:agent-auto-paused', { detail: event }));
        return;
    }
  });
}
