import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import { formatNextFireRelative } from '../screens/agents/schedule-helpers';
import type { AgentName } from '../../shared/types';

interface AgentEnabledDetail {
  agentId: string;
  agentName: AgentName;
  displayName: string;
  nextFireAt: string | null;
  scheduleLabel: string;
  hasSchedule: boolean;
}

interface ToastEntry extends AgentEnabledDetail {
  toastId: string;
}

// Long enough for the user to read the cadence + sequential explanation
// before it dismisses itself. Manually dismissable via the × button.
const AUTO_DISMISS_MS = 9000;

export function AgentEnabledToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const lastHeartbeat = useStore((s) => s.lastHeartbeat);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    function onAgentEnabled(e: Event): void {
      const detail = (e as CustomEvent<AgentEnabledDetail>).detail;
      if (!detail?.agentId) return;
      const toastId = `${detail.agentId}-${Date.now()}`;
      setToasts((prev) => [{ ...detail, toastId }, ...prev]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
      }, AUTO_DISMISS_MS);
    }
    window.addEventListener('obelisk:agent-enabled', onAgentEnabled);
    return () => window.removeEventListener('obelisk:agent-enabled', onAgentEnabled);
  }, []);

  if (toasts.length === 0) return null;

  function dismiss(toastId: string): void {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }

  function viewCommandCenter(toastId: string): void {
    setRoute('home');
    dismiss(toastId);
  }

  return (
    <div className="agent-enabled-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        // Recompute the relative time off the heartbeat so it stays fresh
        // while the toast is visible (e.g. "in 4m 12s" → "in 3m 42s").
        const relative = formatNextFireRelative(t.nextFireAt, new Date());
        // Reference the heartbeat so the memo invalidates each tick. eslint
        // doesn't understand this so suppress the warning.
        void lastHeartbeat;
        const cadenceLine = t.hasSchedule
          ? `Runs ${t.scheduleLabel.toLowerCase()} — one at a time, never in parallel.`
          : 'No schedule set — only fires when you click Run.';
        const nextLine = relative
          ? `Next fire ${relative}.`
          : t.hasSchedule
            ? 'Next fire pending — the scheduler ticks every 30 s.'
            : '';
        return (
          <div
            key={t.toastId}
            className="tpg-toast tpg-toast-ok agent-enabled-toast"
            data-testid={`agent-enabled-toast-${t.agentId}`}
            role="group"
          >
            <div className="tpg-toast-icon">
              <Icon.Check size={14} />
            </div>
            <div className="tpg-toast-body">
              <div className="tpg-toast-headline">{t.displayName} is active</div>
              <div className="tpg-toast-sub">{labelForAgent(t.agentName)}</div>
              <div className="tpg-toast-hint">{cadenceLine}</div>
              {nextLine ? <div className="tpg-toast-hint">{nextLine}</div> : null}
            </div>
            <div className="tpg-toast-actions">
              <button
                type="button"
                className="btn primary sm"
                onClick={() => viewCommandCenter(t.toastId)}
              >
                Open
              </button>
              <button
                type="button"
                className="btn ghost icon"
                onClick={() => dismiss(t.toastId)}
                aria-label="Dismiss"
              >
                <Icon.Close size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
