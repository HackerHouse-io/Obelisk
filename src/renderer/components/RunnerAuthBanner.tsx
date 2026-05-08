import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { RunnerLoginActionCard } from './RunnerLoginActionCard';
import type { Run, RunnerKind } from '../../shared/types';

const KNOWN_RUNNERS: RunnerKind[] = ['claude', 'codex'];

/**
 * Top-of-app banner that surfaces a "you need to sign in" CTA whenever any
 * runner's most recent terminal run failed with RUNNER_LOGIN_REQUIRED.
 * Lives at the shell so it persists across screen navigation. Auto-clears
 * the moment a run with that runner reaches `done`.
 *
 * Per-runner dismiss is session-local — sign-in really did happen, the next
 * successful run will clear the state regardless. Dismissing only hides the
 * banner until the user navigates somewhere that re-fetches runs.
 */
export function RunnerAuthBanner(): ReactElement | null {
  const runs = useStore((s) => s.runs);
  const [dismissed, setDismissed] = useState<Set<RunnerKind>>(new Set());

  const signedOutRunners = useMemo(() => {
    const out: RunnerKind[] = [];
    for (const runner of KNOWN_RUNNERS) {
      const recent = mostRecentTerminalRun(runs, runner);
      if (recent && recent.errorCode === 'RUNNER_LOGIN_REQUIRED') {
        out.push(runner);
      }
    }
    return out;
  }, [runs]);

  // Whenever a runner's status changes from signed-out to OK, drop it from
  // the dismissed set so future failures pop a fresh banner.
  useEffect(() => {
    setDismissed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const r of Array.from(next)) {
        if (!signedOutRunners.includes(r)) {
          next.delete(r);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [signedOutRunners]);

  const visibleRunners = signedOutRunners.filter((r) => !dismissed.has(r));
  if (visibleRunners.length === 0) return null;

  function dismiss(runner: RunnerKind): void {
    setDismissed((prev) => {
      if (prev.has(runner)) return prev;
      return new Set([...prev, runner]);
    });
  }

  return (
    <div className="runner-auth-banner-stack">
      {visibleRunners.map((runner) => (
        <div key={runner} className="runner-auth-banner-wrapper">
          <RunnerLoginActionCard
            runner={runner}
            variant="banner"
            onSignedIn={() => dismiss(runner)}
          />
          <button
            type="button"
            className="btn ghost icon runner-auth-banner-dismiss"
            onClick={() => dismiss(runner)}
            aria-label={`Dismiss ${runner} sign-in banner`}
            title="Dismiss until the next failed run"
          >
            <Icon.Close size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

function mostRecentTerminalRun(runs: Record<string, Run>, runner: RunnerKind): Run | null {
  let best: Run | null = null;
  for (const r of Object.values(runs)) {
    if (r.runnerUsed !== runner) continue;
    if (r.state !== 'done' && r.state !== 'failed' && r.state !== 'cancelled') continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = r.finishedAt ?? r.startedAt ?? '';
    const b = best.finishedAt ?? best.startedAt ?? '';
    if (a > b) best = r;
  }
  return best;
}
