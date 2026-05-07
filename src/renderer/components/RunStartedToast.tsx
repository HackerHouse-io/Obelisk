import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import type { AgentName } from '../../shared/types';

/**
 * Two emit paths land on this toast:
 *   1. Plan-driven runs from TestPlans.tsx — payload includes planName +
 *      caseCount so we render "{planName} · N cases".
 *   2. Ad-hoc "Run now" from Agents.tsx — payload only has runId / agentName /
 *      displayName (no plan binding at this layer; the orchestrator picks the
 *      plan internally). We fall back to "Starting now" for the sub line.
 */
interface RunStartedDetail {
  runId: string;
  agentName: AgentName;
  /** Optional — present for plan-driven runs from the Test Plans screen. */
  planName?: string;
  /** Optional — number of cases in the plan. */
  caseCount?: number;
  /** Optional — instance label, used when no plan is bound. */
  displayName?: string;
}

interface ToastEntry extends RunStartedDetail {
  toastId: string;
}

const AUTO_DISMISS_MS = 5500;

export function RunStartedToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    function onRunStarted(e: Event): void {
      const detail = (e as CustomEvent<RunStartedDetail>).detail;
      if (!detail?.runId) return;
      const toastId = `${detail.runId}-${Date.now()}`;
      setToasts((prev) => [{ ...detail, toastId }, ...prev]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
      }, AUTO_DISMISS_MS);
    }
    window.addEventListener('obelisk:run-started', onRunStarted);
    return () => window.removeEventListener('obelisk:run-started', onRunStarted);
  }, []);

  if (toasts.length === 0) return null;

  function dismiss(toastId: string): void {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }

  function viewRun(runId: string, toastId: string): void {
    setRoute('mission');
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('obelisk:focus-run', { detail: { runId } }));
    });
    dismiss(toastId);
  }

  return (
    <div className="run-started-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        const headline = t.displayName
          ? `${t.displayName} is running`
          : `${labelForAgent(t.agentName)} is running`;
        const sub =
          t.planName && t.caseCount !== undefined
            ? `${t.planName} · ${t.caseCount} case${t.caseCount === 1 ? '' : 's'}`
            : t.planName
              ? t.planName
              : 'Starting now — see Mission Control for live progress.';
        return (
          <div
            key={t.toastId}
            className="tpg-toast tpg-toast-busy run-started-toast"
            data-testid={`run-started-toast-${t.runId}`}
            role="group"
          >
            <div className="tpg-toast-icon">
              <Icon.Spinner size={14} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
            <div className="tpg-toast-body">
              <div className="tpg-toast-headline">{headline}</div>
              <div className="tpg-toast-sub">{sub}</div>
            </div>
            <div className="tpg-toast-actions">
              <button
                type="button"
                className="btn primary sm"
                onClick={() => viewRun(t.runId, t.toastId)}
              >
                View
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
