/**
 * In-memory registry of in-flight runs. Keyed by run id, maps to an
 * AbortController that the orchestrator wires into the CLI runner. When the
 * user clicks Stop, the IPC handler `agents:cancel` calls `cancel(runId)`,
 * which aborts the spawn (SIGTERM-then-SIGKILL via spawnAgentCli) and marks
 * the run "user-cancelled" so the orchestrator transitions it to `cancelled`
 * instead of `failed`.
 *
 * Entries are removed in `runAgent`'s finally block. The map only ever holds
 * runs the current process is actively driving — restarts wipe it, which is
 * correct: a restart kills any in-flight subprocesses too.
 */

interface ActiveRun {
  controller: AbortController;
  /** Set to true when the user clicks Stop, used to differentiate cancelled vs crashed. */
  cancelled: boolean;
}

const active = new Map<string, ActiveRun>();

export function registerRun(runId: string): AbortController {
  const controller = new AbortController();
  active.set(runId, { controller, cancelled: false });
  return controller;
}

export function isCancelled(runId: string): boolean {
  return active.get(runId)?.cancelled ?? false;
}

export function isActive(runId: string): boolean {
  return active.has(runId);
}

/** Returns true if the run was active and we issued the abort, false otherwise. */
export function cancelRun(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  entry.cancelled = true;
  entry.controller.abort();
  return true;
}

export function unregisterRun(runId: string): void {
  active.delete(runId);
}

/** Test-only: drop everything between vitest cases. */
export function clearActiveRunsForTesting(): void {
  active.clear();
}
