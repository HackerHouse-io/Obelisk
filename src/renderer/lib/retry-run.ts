import { useStore } from '../state/store';
import type { Run } from '../../shared/types';
import type { Result } from '../../shared/errors';

type RetryRes = { runId: string; taskRef: string | null; taskContext: string | null };

/**
 * Re-run the task a terminal/paused run targeted. On success, dispatch the
 * same `obelisk:run-started` event a fresh "Run now" emits so the shell's
 * RunStartedToast shows the spinner + "View" — without this the retry is
 * silent and reads as "nothing happened". `clarification` (set by the
 * spec-clarification modal) is threaded into the new run's prompt and posted
 * as a GitHub issue comment by the backend.
 *
 * Returns the raw IPC Result so callers can surface errors inline (modal) or
 * via an alert (toolbar).
 */
export async function retryRun(run: Run, clarification?: string): Promise<Result<RetryRes>> {
  const res = await window.obelisk.invoke('runs:retry', {
    runId: run.id,
    ...(clarification ? { userClarification: clarification } : {}),
  });
  if (res.ok) {
    const repoFullName =
      useStore.getState().repos.find((r) => r.id === run.repoId)?.githubFullName ?? null;
    window.dispatchEvent(
      new CustomEvent('obelisk:run-started', {
        detail: {
          runId: res.value.runId,
          agentName: run.agentName,
          taskRef: res.value.taskRef ?? null,
          taskContext: res.value.taskContext ?? null,
          repoFullName,
        },
      }),
    );
  }
  return res;
}
