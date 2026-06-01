import type { RunnerKind } from '../../shared/types';

/**
 * Auto-fallback policy (TECH_DESIGN.md §8.3):
 * if a runner returns ok=false with reason 'crash' or 'non_zero_exit'
 * twice in a row for the same task_ref, the next attempt swaps to the
 * other runner. After 4 total attempts across both runners, give up.
 */

interface FailureKey {
  taskRef: string;
  runner: RunnerKind;
}

interface State {
  consecutiveFails: number;
  totalAttempts: number;
}

class FallbackTracker {
  private state = new Map<string, State>();

  private key(k: FailureKey): string {
    return `${k.taskRef}::${k.runner}`;
  }

  private taskKey(taskRef: string): string {
    return `total::${taskRef}`;
  }

  private totalAttempts(taskRef: string): number {
    return this.state.get(this.taskKey(taskRef))?.totalAttempts ?? 0;
  }

  /**
   * Pick the next runner to try given the current preference and the
   * recent failure history.
   *
   * Returns null if we've exhausted attempts (>= 4) and the run should
   * be marked failed.
   */
  decide(taskRef: string, preferred: RunnerKind): RunnerKind | null {
    if (this.totalAttempts(taskRef) >= 4) return null;

    const preferredFails =
      this.state.get(this.key({ taskRef, runner: preferred }))?.consecutiveFails ?? 0;
    if (preferredFails < 2) return preferred;

    const other: RunnerKind = preferred === 'claude' ? 'codex' : 'claude';
    return other;
  }

  /**
   * Call after each run completes. `crash` and `non_zero_exit` count
   * against the consecutive-fails counter; everything else resets it.
   */
  record(taskRef: string, runner: RunnerKind, outcome: 'ok' | 'fatal_fail' | 'soft_fail'): void {
    const k = this.key({ taskRef, runner });
    const tk = this.taskKey(taskRef);
    const cur = this.state.get(k) ?? { consecutiveFails: 0, totalAttempts: 0 };
    const total = this.state.get(tk) ?? { consecutiveFails: 0, totalAttempts: 0 };
    total.totalAttempts += 1;
    this.state.set(tk, total);

    if (outcome === 'fatal_fail') {
      cur.consecutiveFails += 1;
    } else {
      cur.consecutiveFails = 0;
    }
    cur.totalAttempts += 1;
    this.state.set(k, cur);
  }

  /**
   * Clear all tracking for a task. Called by the orchestrator at the start of
   * each run attempt so an auto-retry gets a fresh 4-spawn fallback budget
   * (the tracker is meant to persist only across the in-attempt runner swaps,
   * not across separate runAgent calls). Also used by tests.
   */
  clear(taskRef: string): void {
    for (const k of [...this.state.keys()]) {
      if (k.endsWith(`::${taskRef}`) || k.endsWith(taskRef)) this.state.delete(k);
    }
  }
}

export const runnerFallback = new FallbackTracker();

/**
 * `crash` and `non_zero_exit` are fatal_fail; everything else is soft.
 * Caller passes the run reason verbatim.
 */
export function classifyOutcome(reason: string | undefined): 'ok' | 'fatal_fail' | 'soft_fail' {
  if (!reason) return 'ok';
  if (reason === 'crash' || reason === 'non_zero_exit') return 'fatal_fail';
  return 'soft_fail';
}
