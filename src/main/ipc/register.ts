import { app, ipcMain } from 'electron';
import { fromException, ok, err, type Result } from '../../shared/errors';
import type { IpcChannel, IpcMap } from '../../shared/types';
import { dbPath } from '../db';

type Handler<C extends IpcChannel> = (payload: IpcMap[C]['req']) => Promise<IpcMap[C]['res']>;

const handlers = new Map<IpcChannel, (payload: unknown) => Promise<unknown>>();

function register<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  handlers.set(channel, handler as (payload: unknown) => Promise<unknown>);
}

const notImplemented = (channel: string) => async (): Promise<never> => {
  throw new Error(`channel '${channel}' is not implemented yet`);
};

/**
 * Phase 1 wires every channel from docs/TECH_DESIGN.md §3.1 to a stub
 * that returns a NOT_IMPLEMENTED error. Subsequent phases replace each
 * stub with a real implementation.
 *
 *   Phase 2: auth:*, repos:*, allowlist:*
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

  // Stubs — phases 2+ replace each one.
  register('auth:status', async () => ({ signedIn: false }));
  register('auth:signIn', notImplemented('auth:signIn'));
  register('auth:complete', notImplemented('auth:complete'));
  register('auth:upgradeScope', notImplemented('auth:upgradeScope'));
  register('auth:setRunnerKey', notImplemented('auth:setRunnerKey'));
  register('auth:signOut', notImplemented('auth:signOut'));

  register('repos:list', async () => []);
  register('repos:connect', notImplemented('repos:connect'));
  register('repos:setMode', notImplemented('repos:setMode'));

  register('allowlist:list', async () => []);
  register('allowlist:add', notImplemented('allowlist:add'));
  register('allowlist:remove', notImplemented('allowlist:remove'));

  register('agents:list', async () => []);
  register('agents:run', notImplemented('agents:run'));
  register('agents:cancel', notImplemented('agents:cancel'));
  register('agents:update', notImplemented('agents:update'));

  register('runs:list', async () => []);
  register('runs:get', notImplemented('runs:get'));

  register('backlog:list', async () => []);
  register('backlog:reorder', notImplemented('backlog:reorder'));
  register('backlog:setOverride', notImplemented('backlog:setOverride'));

  register('playbook:get', async () => ({ files: [], draft: true }));
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
