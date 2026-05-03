import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { runMigrations } from './db/migrations';
import { closeDb } from './db';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/register';
import {
  registerObeliskProtocolSchemes,
  registerObeliskProtocolHandler,
} from './protocol/obelisk-protocol';
import { startScheduler, stopScheduler } from './scheduler/tick';

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
  closeDb();
});
