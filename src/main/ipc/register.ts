import { app, ipcMain } from 'electron';
import { fromException, ok, type Result } from '../../shared/errors';
import type { IpcChannel, IpcMap } from '../../shared/types';
import { dbPath } from '../db';
import {
  handleAuthStatus,
  handleAuthSignIn,
  handleAuthComplete,
  handleAuthUpgradeScope,
  handleAuthSignOut,
} from './auth';
import {
  handleReposList,
  handleReposConnect,
  handleReposSetMode,
  handleReposPickFolder,
  handleReposListGitHubRepos,
} from './repos';
import { handleAllowlistList, handleAllowlistAdd, handleAllowlistRemove } from './allowlist';
import {
  handleAgentsList,
  handleAgentsRun,
  handleAgentsCancel,
  handleAgentsUpdate,
} from './agents';
import { handleRunsList, handleRunsGet } from './runs';
import { handleBacklogList, handleBacklogReorder, handleBacklogSetOverride } from './backlog';
import { handlePlaybookGet, handlePlaybookSave } from './playbook';
import { handleSettingsGet, handleSettingsUpdate } from './settings';

type Handler<C extends IpcChannel> = (payload: IpcMap[C]['req']) => Promise<IpcMap[C]['res']>;

const handlers = new Map<IpcChannel, (payload: unknown) => Promise<unknown>>();

function register<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  handlers.set(channel, handler as (payload: unknown) => Promise<unknown>);
}

/**
 * Every IPC channel from `IpcMap` resolves to a real handler. Phases that
 * own each channel: auth/repos/allowlist (2), agents/runs (4), backlog (5),
 * playbook (5), settings (9).
 */
export function registerIpcHandlers(): void {
  register('system:info', async () => ({
    version: app.getVersion(),
    dbPath: dbPath(),
    userDataDir: app.getPath('userData'),
    node: process.versions.node,
    electron: process.versions.electron ?? '',
  }));

  // Auth (Phase 2 — real)
  register('auth:status', handleAuthStatus);
  register('auth:signIn', handleAuthSignIn);
  register('auth:complete', handleAuthComplete);
  register('auth:upgradeScope', handleAuthUpgradeScope);
  register('auth:signOut', handleAuthSignOut);

  // Repos (Phase 2 — real)
  register('repos:list', handleReposList);
  register('repos:connect', handleReposConnect);
  register('repos:setMode', handleReposSetMode);
  register('repos:pickFolder', handleReposPickFolder);
  register('repos:listGitHubRepos', handleReposListGitHubRepos);

  // Allowlist (Phase 2 — real)
  register('allowlist:list', handleAllowlistList);
  register('allowlist:add', handleAllowlistAdd);
  register('allowlist:remove', handleAllowlistRemove);

  // Agents (Phase 4 — real)
  register('agents:list', handleAgentsList);
  register('agents:run', handleAgentsRun);
  register('agents:cancel', handleAgentsCancel);
  register('agents:update', handleAgentsUpdate);

  // Runs (Phase 4 — real)
  register('runs:list', handleRunsList);
  register('runs:get', handleRunsGet);

  // Backlog (Phase 4 — real)
  register('backlog:list', handleBacklogList);
  register('backlog:reorder', handleBacklogReorder);
  register('backlog:setOverride', handleBacklogSetOverride);

  // Playbook (Phase 5 — get; Phase 9 — save)
  register('playbook:get', handlePlaybookGet);
  register('playbook:save', handlePlaybookSave);

  // Settings (Phase 9 — real)
  register('settings:get', handleSettingsGet);
  register('settings:update', handleSettingsUpdate);

  // Bind ipcMain.handle for every registered channel with a single envelope wrapper.
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, payload): Promise<Result<unknown>> => {
      try {
        const value = await handler(payload);
        return ok(value);
      } catch (e) {
        return fromException(e);
      }
    });
  }
}

export function unregisterIpcHandlers(): void {
  for (const channel of handlers.keys()) {
    ipcMain.removeHandler(channel);
  }
  handlers.clear();
}
