import { discoverModels } from '../runners/model-discovery';
import type { IpcMap } from '../../shared/types';

/**
 * IPC: list models for a runner. CLI-sourced, no API key. A warm call returns
 * cached versions instantly and refreshes stale ones in the background; a
 * `refresh` call (the dropdown's refresh button) forces a fresh init-probe.
 * Renderers cache responses on their side.
 */
export async function handleModelsList(
  payload: IpcMap['models:list']['req'],
): Promise<IpcMap['models:list']['res']> {
  return discoverModels(payload.runner, { refresh: payload.refresh ?? false });
}
