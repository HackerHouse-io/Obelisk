import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import type { AgentName } from '../../shared/types';

interface AutoPausedDetail {
  repoId: string;
  agentId: string;
  agentName: AgentName;
  displayName: string;
  reason: 'consecutive_failures' | 'needs_test_plan';
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
}

interface ToastEntry extends AutoPausedDetail {
  toastId: string;
}

export function AgentAutoPausedToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    function onAutoPaused(e: Event): void {
      const detail = (e as CustomEvent<AutoPausedDetail>).detail;
      if (!detail?.agentId) return;
      const toastId = `${detail.agentId}-${Date.now()}`;
      // Dedup: replace any existing toast for the same agent so the user
      // doesn't see two "auto-paused" cards from rapid back-to-back trips.
      setToasts((prev) => [
        { ...detail, toastId },
        ...prev.filter((t) => t.agentId !== detail.agentId),
      ]);
    }
    window.addEventListener('obelisk:agent-auto-paused', onAutoPaused);
    return () => window.removeEventListener('obelisk:agent-auto-paused', onAutoPaused);
  }, []);

  if (toasts.length === 0) return null;

  function dismiss(toastId: string): void {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }

  function inspect(t: ToastEntry): void {
    setRoute('mission');
    dismiss(t.toastId);
  }

  return (
    <div className="agent-autopause-toast-stack" role="alert" aria-live="assertive">
      {toasts.map((t) => {
        const needsPlan = t.reason === 'needs_test_plan';
        const errorBit = !needsPlan && t.lastErrorCode ? ` (${t.lastErrorCode})` : '';
        const sub = needsPlan
          ? `${labelForAgent(t.agentName)} · no test plan to run. Create or attach one, then re-enable.`
          : `${labelForAgent(t.agentName)} · ${t.consecutiveFailures} consecutive scheduled failures. Investigate before re-enabling.`;
        const detail = needsPlan
          ? 'Open Coverage to generate or attach a plan for this agent.'
          : t.lastErrorSummary
            ? `Last error: ${t.lastErrorSummary.slice(0, 160)}${
                t.lastErrorSummary.length > 160 ? '…' : ''
              }`
            : 'Click Inspect to see the failed runs.';
        return (
          <div
            key={t.toastId}
            className="tpg-toast tpg-toast-error agent-autopause-toast"
            data-testid={`agent-autopause-toast-${t.agentId}`}
            role="group"
          >
            <div className="tpg-toast-icon">
              <Icon.AlertTri size={14} />
            </div>
            <div className="tpg-toast-body">
              <div className="tpg-toast-headline">
                {t.displayName} auto-paused{errorBit}
              </div>
              <div className="tpg-toast-sub">{sub}</div>
              <div className="tpg-toast-hint">{detail}</div>
            </div>
            <div className="tpg-toast-actions">
              <button type="button" className="btn primary sm" onClick={() => inspect(t)}>
                Inspect
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
