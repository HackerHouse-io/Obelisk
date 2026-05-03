import { app, ipcMain } from 'electron';
import { fromException, ok, err, type Result } from '../../shared/errors';
import type { IpcChannel, IpcMap } from '../../shared/types';
import { dbPath } from '../db';
import {
  handleAuthStatus,
  handleAuthSignIn,
  handleAuthComplete,
  handleAuthUpgradeScope,
  handleAuthSetRunnerKey,
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

type Handler<C extends IpcChannel> = (payload: IpcMap[C]['req']) => Promise<IpcMap[C]['res']>;

const handlers = new Map<IpcChannel, (payload: unknown) => Promise<unknown>>();

function register<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  handlers.set(channel, handler as (payload: unknown) => Promise<unknown>);
}

const notImplemented = (channel: string) => async (): Promise<never> => {
  throw new Error(`channel '${channel}' is not implemented yet`);
};

/**
 * Phase 2 wires real handlers for auth:*, repos:*, allowlist:*. Other
 * channels remain as NOT_IMPLEMENTED stubs until later phases:
 *   Phase 4: agents:*, runs:*
 *   Phase 5: backlog:*, playbook:*
 *   Phase 9: settings:* full surface
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
  register('auth:setRunnerKey', handleAuthSetRunnerKey);
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

  register('playbook:get', async (payload) => {
    const { getPlaybookDraft } = await import('../agents/playbook-bootstrapper/publish');
    const draft = getPlaybookDraft(payload.repoId);
    if (draft) return { files: draft.files, draft: true };
    return { files: [], draft: false };
  });
  register('playbook:save', notImplemented('playbook:save'));

  register('settings:get', async () => ({
    defaultRunner: 'claude',
    attributionMode: 'user',
    cloudExecutionEnabled: false,
  }));
  register('settings:update', notImplemented('settings:update'));

  // Bind ipcMain.handle for every registered channel with a single envelope wrapper.
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, payload): Promise<Result<unknown>> => {
      try {
        const value = await handler(payload);
        return ok(value);
      } catch (e) {
        if (e instanceof Error && e.message.includes('not implemented')) {
          return err('NOT_IMPLEMENTED', e.message);
        }
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
