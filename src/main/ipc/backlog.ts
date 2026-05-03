import { listBacklog, reorderBacklog, setBacklogOverride } from '../db/backlog';
import { broadcast } from './bus';
import type { IpcMap } from '../../shared/types';

export async function handleBacklogList(
  payload: IpcMap['backlog:list']['req'],
): Promise<IpcMap['backlog:list']['res']> {
  return listBacklog(payload.repoId);
}

export async function handleBacklogReorder(
  payload: IpcMap['backlog:reorder']['req'],
): Promise<IpcMap['backlog:reorder']['res']> {
  reorderBacklog(payload.repoId, payload.orderedIds);
  broadcast({ type: 'backlog.changed', repoId: payload.repoId });
  return { ok: true };
}

export async function handleBacklogSetOverride(
  payload: IpcMap['backlog:setOverride']['req'],
): Promise<IpcMap['backlog:setOverride']['res']> {
  const updated = setBacklogOverride(payload.itemId, {
    ...(payload.runner !== undefined ? { runnerOverride: payload.runner } : {}),
    ...(payload.agent !== undefined ? { agentOverride: payload.agent } : {}),
  });
  broadcast({ type: 'backlog.changed', repoId: updated.repoId });
  return updated;
}
