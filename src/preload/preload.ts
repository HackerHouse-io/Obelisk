import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { BUS_CHANNEL } from '../shared/ipc-channels';
import type { BusEvent, IpcChannel, IpcMap, ObeliskBridge } from '../shared/types';
import type { Result } from '../shared/errors';

const bridge: ObeliskBridge = {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcMap[C]['req'],
  ): Promise<Result<IpcMap[C]['res']>> {
    return ipcRenderer.invoke(channel, payload) as Promise<Result<IpcMap[C]['res']>>;
  },
  subscribe(handler: (event: BusEvent) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: BusEvent): void => {
      handler(payload);
    };
    ipcRenderer.on(BUS_CHANNEL, listener);
    return (): void => {
      ipcRenderer.removeListener(BUS_CHANNEL, listener);
    };
  },
};

try {
  contextBridge.exposeInMainWorld('obelisk', bridge);
} catch (error) {
  console.error('preload: contextBridge.exposeInMainWorld failed', error);
}
