import { BrowserWindow } from 'electron';
import { BUS_CHANNEL } from '../../shared/ipc-channels';
import type { BusEvent } from '../../shared/types';

type Listener = (event: BusEvent) => void;

const listeners = new Set<Listener>();

/** Test hook: subscribe in-process to bus broadcasts. */
export function addInProcessListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(event: BusEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // Listeners are informational; never break the broadcast loop.
    }
  }
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(BUS_CHANNEL, event);
      }
    }
  } catch {
    // No Electron app context (e.g. unit tests). Silent.
  }
}
