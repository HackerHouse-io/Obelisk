import { BrowserWindow } from 'electron';
import { BUS_CHANNEL } from '../../shared/ipc-channels';
import type { BusEvent } from '../../shared/types';

export function broadcast(event: BusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(BUS_CHANNEL, event);
    }
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(intervalMs = 5000): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    broadcast({ type: 'system.heartbeat', at: new Date().toISOString() });
  }, intervalMs);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
