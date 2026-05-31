import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import type { BusEvent, CoverageRunSummary } from '../../shared/types';

/**
 * Surfaces the Coverage Agent's progress as transient toasts, so the user
 * notices what it found / when it paused / when it finished even when they're
 * not looking at the Coverage screen. Driven entirely by `coverageRun.progress`
 * bus events.
 *
 *   - findings landed  → "Coverage Agent found N issues in <feature>" (View → Mission Control)
 *   - paused for review → sticky toast prompting Resume on the Coverage screen
 *   - pass complete     → sticky summary toast
 *
 * Mounted once at the shell, alongside RunStartedToast.
 */

const AUTO_DISMISS_MS = 6000;

type Tone = 'busy' | 'ok' | 'error';

interface ToastEntry {
  toastId: string;
  tone: Tone;
  headline: string;
  sub: string;
  /** When set, a "View" button deep-links to this run in Mission Control. */
  runId?: string;
  sticky: boolean;
}

interface RunMemo {
  findings: number;
  stage: CoverageRunSummary['stage'];
}

export function CoverageFindingsToast(): ReactElement | null {
  const setRoute = useStore((s) => s.setRoute);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  // Per-run memory of the last findings total + stage we toasted on, so we only
  // fire on a real increase / transition (events repaint on every step).
  const memo = useRef<Map<string, RunMemo>>(new Map());
  const seq = useRef(0);

  useEffect(() => {
    function push(entry: Omit<ToastEntry, 'toastId'>): void {
      seq.current += 1;
      const toastId = `cov-${seq.current}`;
      setToasts((prev) => [{ ...entry, toastId }, ...prev].slice(0, 4));
      if (!entry.sticky) {
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
        }, AUTO_DISMISS_MS);
      }
    }

    const unsubscribe = window.obelisk.subscribe((event: BusEvent) => {
      if (event.type !== 'coverageRun.progress') return;
      const run = event.run;
      const prev = memo.current.get(run.id) ?? { findings: 0, stage: 'queued' };
      const total = run.steps.reduce((n, s) => n + (s.findings ?? 0), 0);

      // New findings since we last toasted for this run.
      if (total > prev.findings) {
        const delta = total - prev.findings;
        // Attribute to the most recent hunt step that carries findings.
        const lastHunt = [...run.steps]
          .reverse()
          .find((s) => s.kind === 'hunt' && (s.findings ?? 0) > 0);
        const feature = lastHunt?.featureLabel ?? 'your code';
        push({
          tone: 'busy',
          headline: `Coverage Agent found ${delta} issue${delta === 1 ? '' : 's'}`,
          sub: `in ${feature} — review in Mission Control`,
          ...(lastHunt?.runId ? { runId: lastHunt.runId } : {}),
          sticky: false,
        });
      }

      // Stage transitions worth announcing.
      if (run.stage !== prev.stage) {
        if (run.stage === 'paused') {
          push({
            tone: 'busy',
            headline: 'Coverage Agent paused for review',
            sub: run.status ?? 'Open Coverage to resume.',
            sticky: true,
          });
        } else if (run.stage === 'done') {
          push({
            tone: 'ok',
            headline: 'Coverage pass complete',
            sub: run.status ?? `Found ${total} issue${total === 1 ? '' : 's'}.`,
            sticky: true,
          });
        }
      }

      memo.current.set(run.id, { findings: total, stage: run.stage });
    });
    return unsubscribe;
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
          className={`tpg-toast tpg-toast-${t.tone} coverage-findings-toast`}
          data-testid="coverage-findings-toast"
          role="group"
        >
          <div className="tpg-toast-icon">
            {t.tone === 'ok' ? <Icon.Check size={14} /> : <Icon.Bug size={14} />}
          </div>
          <div className="tpg-toast-body">
            <div className="tpg-toast-headline">{t.headline}</div>
            <div className="tpg-toast-sub">{t.sub}</div>
          </div>
          <div className="tpg-toast-actions">
            {t.runId ? (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => viewRun(t.runId!, t.toastId)}
              >
                View
              </button>
            ) : null}
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
