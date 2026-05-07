import { discoverModels } from '../runners/model-discovery';
import type { IpcMap } from '../../shared/types';

/**
 * IPC: list models for a runner. Returns a freshly-merged list each call —
 * the discovery layer is cheap (CLI config read + optional one-shot HTTP)
 * and renderers cache responses on their side. Renderers can call this on
 * mount and again when the user hits the dropdown's refresh button.
 */
export async function handleModelsList(
  payload: IpcMap['models:list']['req'],
): Promise<IpcMap['models:list']['res']> {
  return discoverModels(payload.runner);
}
