import { contextBridge } from 'electron';

const obelisk = {
  version: '0.0.1',
};

try {
  contextBridge.exposeInMainWorld('obelisk', obelisk);
} catch (error) {
  console.error('preload: contextBridge.exposeInMainWorld failed', error);
}

export type ObeliskBridge = typeof obelisk;
