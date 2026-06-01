import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import type { BusEvent } from '../../shared/types';

/**
 * Transient toast shown when a run's transient-failure auto-retries are all
 * spent. The agent is NOT stopped — it keeps its schedule and tries fresh next
 * cycle — so this is informational, auto-dismissing, with a link to inspect the
 * failed run. Mounted once at the shell alongside the other run toasts.
 */

const AUTO_DISMISS_MS = 8000;

interface ToastEntry {
  toastId: string;
  headline: string;
  sub: string;
  runId: string;
}

export function RunRetryExhaustedToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    return window.obelisk.subscribe((event: BusEvent) => {
      if (event.type !== 'run.retriesExhausted') return;
      seq.current += 1;
      const toastId = `rre-${seq.current}`;
      const what = event.label ?? labelForAgent(event.agentName);
      setToasts((prev) =>
        [
          {
            toastId,
            runId: event.runId,
            headline: `${event.displayName} run failed`,
            sub: `${what} — gave up after ${event.attempts} retries. Will try again next cycle.`,
          },
          ...prev,
        ].slice(0, 4),
      );
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
      }, AUTO_DISMISS_MS);
    });
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
    <div className="coverage-findings-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.toastId}
          className="tpg-toast tpg-toast-error"
          data-testid="run-retry-exhausted-toast"
          role="group"
        >
          <div className="tpg-toast-icon">
            <Icon.AlertTri size={14} />
          </div>
          <div className="tpg-toast-body">
            <div className="tpg-toast-headline">{t.headline}</div>
            <div className="tpg-toast-sub">{t.sub}</div>
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
      ))}
    </div>
  );
}
