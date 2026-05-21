import type { AgentName, RunnerKind } from '../../shared/types';
import type { Result } from '../../shared/errors';

export interface RunAgentOptions {
  taskId?: string;
  runnerOverride?: RunnerKind;
  /** Empty string is treated as "no override" — agent row / CLI default applies. */
  modelOverride?: string;
}

/**
 * Renderer-side helper for "Run <type> now" buttons that don't care which
 * specific instance fires (Home quick actions, CommandPalette, Backlog row
 * triggers). Looks up the first instance of the requested type and dispatches
 * via `agents:run`.
 *
 * Returns the same Result shape as the underlying IPC so callers can use the
 * regular `if (!res.ok) showApiAlert(res.error)` pattern.
 */
export async function runAgentByName(
  repoId: string,
  agentName: AgentName,
  taskIdOrOptions?: string | RunAgentOptions,
): Promise<Result<{ runId: string }>> {
  const opts: RunAgentOptions =
    typeof taskIdOrOptions === 'string' ? { taskId: taskIdOrOptions } : (taskIdOrOptions ?? {});
  const list = await window.obelisk.invoke('agents:list', { repoId });
  if (!list.ok) return list;
  const found = list.value.find((a) => a.name === agentName);
  if (!found) {
    return {
      ok: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: `No ${agentName} installed for this repo`,
      },
    };
  }
  return window.obelisk.invoke('agents:run', {
    agentId: found.id,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.runnerOverride ? { runnerOverride: opts.runnerOverride } : {}),
    ...(opts.modelOverride !== undefined && opts.modelOverride.trim().length > 0
      ? { modelOverride: opts.modelOverride.trim() }
      : {}),
  });
}
