import { getSetting, setSetting } from '../db/settings';
import type { IpcMap, Settings } from '../../shared/types';

const DEFAULTS: Settings = {
  defaultRunner: 'claude',
  attributionMode: 'user',
  cloudExecutionEnabled: false, // v0.1: cloud execution lands in v0.2
};

export async function handleSettingsGet(): Promise<IpcMap['settings:get']['res']> {
  return {
    defaultRunner:
      getSetting<Settings['defaultRunner']>('app', 'defaultRunner') ?? DEFAULTS.defaultRunner,
    attributionMode:
      getSetting<Settings['attributionMode']>('app', 'attributionMode') ?? DEFAULTS.attributionMode,
    cloudExecutionEnabled: false,
  };
}

export async function handleSettingsUpdate(
  payload: IpcMap['settings:update']['req'],
): Promise<IpcMap['settings:update']['res']> {
  if (payload.defaultRunner !== undefined) {
    setSetting('app', 'defaultRunner', payload.defaultRunner);
  }
  if (payload.attributionMode !== undefined) {
    setSetting('app', 'attributionMode', payload.attributionMode);
  }
  // cloudExecutionEnabled is a v0.1 noop — the toggle is disabled in the UI.
  return handleSettingsGet();
}
