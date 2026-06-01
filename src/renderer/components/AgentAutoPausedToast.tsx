import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import type { AgentName } from '../../shared/types';

type AutoPausedReason =
  | 'consecutive_failures'
  | 'needs_test_plan'
  | 'login_required'
  | 'runner_missing'
  | 'mode_too_low';

interface AutoPausedDetail {
  repoId: string;
  agentId: string;
  agentName: AgentName;
  displayName: string;
  reason: AutoPausedReason;
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
        const { sub, detail } = stoppedCopy(t);
        // For the generic consecutive-failure case we still surface the code.
        const errorBit =
          t.reason === 'consecutive_failures' && t.lastErrorCode ? ` (${t.lastErrorCode})` : '';
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
                {t.displayName} stopped{errorBit}
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

/**
 * Per-reason copy for the "stopped" toast. Each permanent reason gets a
 * specific, actionable sentence so the user knows exactly what to fix before
 * re-enabling. Transient failures never reach here — they're retried, not
 * stopped.
 */
function stoppedCopy(t: AutoPausedDetail): { sub: string; detail: string } {
  const who = labelForAgent(t.agentName);
  switch (t.reason) {
    case 'needs_test_plan':
      return {
        sub: `${who} · no test plan to run.`,
        detail: 'Open Coverage to generate or attach a plan, then re-enable.',
      };
    case 'login_required':
      return {
        sub: `${who} · the coding CLI is not signed in.`,
        detail: "Sign in to Claude or Codex (run 'claude' / 'codex' once), then re-enable.",
      };
    case 'runner_missing':
      return {
        sub: `${who} · no coding CLI is installed.`,
        detail: "Install Claude Code or Codex and make sure it's on PATH, then re-enable.",
      };
    case 'mode_too_low':
      return {
        sub: `${who} · this repo's safety mode is too low for it to publish.`,
        detail: 'Raise the safety mode in Settings, then re-enable.',
      };
    case 'consecutive_failures':
    default:
      return {
        sub: `${who} · ${t.consecutiveFailures} consecutive scheduled failures. Investigate before re-enabling.`,
        detail: t.lastErrorSummary
          ? `Last error: ${t.lastErrorSummary.slice(0, 160)}${t.lastErrorSummary.length > 160 ? '…' : ''}`
          : 'Click Inspect to see the failed runs.',
      };
  }
}
