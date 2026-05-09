import { useEffect, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import type { AgentName } from '../../shared/types';

/**
 * Three emit paths land on this toast:
 *   1. Plan-driven runs from TestPlans.tsx — payload includes planName +
 *      caseCount so we render "{planName} · N cases".
 *   2. Ad-hoc "Run now" from Agents.tsx — payload includes the claimed
 *      taskRef + taskContext so users see "Working on issue#42 — Crash on
 *      cold start" with a GitHub link.
 *   3. (Legacy) any other call site that still omits taskRef — falls back
 *      to "Starting now".
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
  /** Stable reference for what got claimed (e.g. `issue#42`, `backlog#<id>`). */
  taskRef?: string | null;
  /** Human-readable title — GitHub issue title, manual backlog title, etc. */
  taskContext?: string | null;
  /** "owner/repo" — used to deep-link `issue#N` to GitHub. */
  repoFullName?: string | null;
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
        const sub = renderToastSub(t);
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

/**
 * Plan runs win on the sub line ("Smoke · 4 cases"), then the claimed task
 * info (issue#42 or manual backlog title), then a generic fallback. Returns
 * a ReactNode so the GitHub link case can render a clickable anchor without
 * dragging unrelated cases through that branch.
 */
function renderToastSub(t: RunStartedDetail): ReactElement | string {
  if (t.planName && t.caseCount !== undefined) {
    return `${t.planName} · ${t.caseCount} case${t.caseCount === 1 ? '' : 's'}`;
  }
  if (t.planName) return t.planName;

  if (t.taskRef?.startsWith('issue#')) {
    const num = t.taskRef.slice('issue#'.length);
    const title = t.taskContext?.trim();
    const href =
      t.repoFullName && /^[\w.-]+\/[\w.-]+$/.test(t.repoFullName)
        ? `https://github.com/${t.repoFullName}/issues/${num}`
        : null;
    return (
      <span>
        Working on{' '}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="run-started-toast-issue-link"
          >
            issue #{num}
          </a>
        ) : (
          `issue #${num}`
        )}
        {title ? ` — ${title}` : ''}
      </span>
    );
  }

  if (t.taskRef?.startsWith('backlog#')) {
    const title = t.taskContext?.trim();
    return title ? `Working on ${title}` : 'Working on a backlog item';
  }

  if (t.taskContext?.trim()) {
    return `Working on ${t.taskContext.trim()}`;
  }
  return 'Starting now — see Mission Control for live progress.';
}
