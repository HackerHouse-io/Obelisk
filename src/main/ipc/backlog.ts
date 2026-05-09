import { listBacklog, reorderBacklog, setBacklogOverride } from '../db/backlog';
import { syncBacklogForRepo } from '../scheduler/backlog-sync';
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

/**
 * Drive a foreground backlog sync against GitHub and return the refreshed
 * list in one call. The sync runs the same code as the periodic sweep
 * (additive upserts + closed-issue reaper), so the user gets exactly
 * what they'd see ~5 min later but immediately. Errors propagate so the
 * UI can surface a toast / banner — no silent failures.
 */
export async function handleBacklogRefresh(
  payload: IpcMap['backlog:refresh']['req'],
): Promise<IpcMap['backlog:refresh']['res']> {
  await syncBacklogForRepo(payload.repoId);
  return listBacklog(payload.repoId);
}
