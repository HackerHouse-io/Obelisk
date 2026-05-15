import type { AgentName } from '../../shared/types';
import type { Result } from '../../shared/errors';

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
  taskId?: string,
): Promise<Result<{ runId: string }>> {
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
    ...(taskId ? { taskId } : {}),
  });
}
