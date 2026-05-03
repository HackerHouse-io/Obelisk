import { listAgentsForRepo, updateAgent } from '../db/agents';
import { runAgent } from '../orchestrator/run';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap } from '../../shared/types';

export async function handleAgentsList(
  payload: IpcMap['agents:list']['req'],
): Promise<IpcMap['agents:list']['res']> {
  return listAgentsForRepo(payload.repoId);
}

export async function handleAgentsRun(
  payload: IpcMap['agents:run']['req'],
): Promise<IpcMap['agents:run']['res']> {
  // Don't await — agent runs are long-running. Kick it off and return the
  // run id so the renderer can subscribe to bus events for live updates.
  // We do await the *initial* selectTask + run-row creation by running the
  // first tick synchronously and grabbing the run id off the result.
  const result = await runAgent({
    repoId: payload.repoId,
    agentName: payload.agentName,
    trigger: 'manual',
    taskId: payload.taskId,
  });
  if (!result.runId) {
    throw new ObeliskError('NOT_FOUND', result.reason ?? 'No task to work on right now.');
  }
  return { runId: result.runId };
}

export async function handleAgentsCancel(
  _payload: IpcMap['agents:cancel']['req'],
): Promise<IpcMap['agents:cancel']['res']> {
  // Phase 4 doesn't have a kill-switch wired into the orchestrator (the
  // AbortController is local to the runWithFallback closure). Phase 10
  // surfaces this via the scheduler-level abort registry.
  throw new ObeliskError(
    'NOT_IMPLEMENTED',
    'Cancel mid-run lands in Phase 10 alongside the scheduler.',
  );
}

export async function handleAgentsUpdate(
  payload: IpcMap['agents:update']['req'],
): Promise<IpcMap['agents:update']['res']> {
  return updateAgent(payload.agentId, payload.patch);
}
