import { getSetting, setSetting } from '../db/settings';
import type { IpcMap, Settings } from '../../shared/types';

const DEFAULTS: Settings = {
  defaultRunner: 'claude',
  claudeModel: '',
  codexModel: '',
  attributionMode: 'user',
  cloudExecutionEnabled: false, // v0.1: cloud execution lands in v0.2
  cardRemoveAction: 'ask',
  lastSelectedRepoId: null,
};

export async function handleSettingsGet(): Promise<IpcMap['settings:get']['res']> {
  return {
    defaultRunner:
      getSetting<Settings['defaultRunner']>('app', 'defaultRunner') ?? DEFAULTS.defaultRunner,
    claudeModel: getSetting<string>('app', 'claudeModel') ?? DEFAULTS.claudeModel,
    codexModel: getSetting<string>('app', 'codexModel') ?? DEFAULTS.codexModel,
    attributionMode:
      getSetting<Settings['attributionMode']>('app', 'attributionMode') ?? DEFAULTS.attributionMode,
    cloudExecutionEnabled: false,
    cardRemoveAction:
      getSetting<Settings['cardRemoveAction']>('app', 'cardRemoveAction') ??
      DEFAULTS.cardRemoveAction,
    lastSelectedRepoId:
      getSetting<string>('app', 'lastSelectedRepoId') ?? DEFAULTS.lastSelectedRepoId,
  };
}

export async function handleSettingsUpdate(
  payload: IpcMap['settings:update']['req'],
): Promise<IpcMap['settings:update']['res']> {
  if (payload.defaultRunner !== undefined) {
    setSetting('app', 'defaultRunner', payload.defaultRunner);
  }
  if (payload.claudeModel !== undefined) {
    setSetting('app', 'claudeModel', payload.claudeModel);
  }
  if (payload.codexModel !== undefined) {
    setSetting('app', 'codexModel', payload.codexModel);
  }
  if (payload.attributionMode !== undefined) {
    setSetting('app', 'attributionMode', payload.attributionMode);
  }
  if (payload.cardRemoveAction !== undefined) {
    setSetting('app', 'cardRemoveAction', payload.cardRemoveAction);
  }
  if (payload.lastSelectedRepoId !== undefined) {
    setSetting('app', 'lastSelectedRepoId', payload.lastSelectedRepoId);
  }
  // cloudExecutionEnabled is a v0.1 noop — the toggle is disabled in the UI.
  return handleSettingsGet();
}
