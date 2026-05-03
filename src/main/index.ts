import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { runMigrations } from './db/migrations';
import { closeDb } from './db';
import { sweepStaleFlowClaims } from './db/qa-flows';
import { shutdownAll, sweepStale as sweepStaleSimSlots } from './agents/ios-qa-pilot/sim-pool';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/register';
import {
  registerObeliskProtocolSchemes,
  registerObeliskProtocolHandler,
} from './protocol/obelisk-protocol';
import { startScheduler, stopScheduler } from './scheduler/tick';

// Two run-timeouts (60min) is a safe ceiling for "this claim is dead, free it".
const STALE_CLAIM_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const isDev = !app.isPackaged;

// Must be called BEFORE app.whenReady() (Electron protocol contract).
registerObeliskProtocolSchemes();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0f',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  try {
    const result = runMigrations();
    console.log(
      `[obelisk] migrations: ${result.applied.length} applied, ${result.total} total on disk`,
    );
  } catch (e) {
    console.error('[obelisk] migrations failed:', e);
  }

  // iOS QA Pilot stale-claim sweep on boot — releases any flow / slot whose
  // owning Electron process died mid-run.
  try {
    const flows = sweepStaleFlowClaims(STALE_CLAIM_MAX_AGE_MS);
    const slots = sweepStaleSimSlots(STALE_CLAIM_MAX_AGE_MS);
    if (flows + slots > 0) {
      console.log(`[obelisk] iOS QA Pilot stale sweep: ${flows} flows, ${slots} slots released`);
    }
  } catch (e) {
    console.error('[obelisk] iOS QA Pilot stale sweep failed:', e);
  }

  registerObeliskProtocolHandler();
  registerIpcHandlers();
  // The scheduler tick broadcasts `system.heartbeat` itself, so the
  // renderer's "bus connected" indicator stays lit without a separate
  // heartbeat timer.
  startScheduler();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopScheduler();
  unregisterIpcHandlers();
  // Best-effort sim shutdown so the user's machine isn't left with N
  // booted simulators after Obelisk quits. Fire-and-forget; we can't
  // make 'before-quit' wait synchronously on a process we spawn.
  void shutdownAll().catch(() => undefined);
  closeDb();
});
