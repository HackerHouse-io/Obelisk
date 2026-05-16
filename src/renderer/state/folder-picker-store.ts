import { create } from 'zustand';

export interface FolderPickerOptions {
  title?: string;
  confirmLabel?: string;
}

interface FolderPickerRequest extends FolderPickerOptions {
  resolve: (path: string | null) => void;
}

interface FolderPickerState {
  current: FolderPickerRequest | null;
  resolve: (path: string | null) => void;
}

export const useFolderPickerStore = create<FolderPickerState>((set, get) => ({
  current: null,
  resolve: (path) => {
    const cur = get().current;
    if (!cur) return;
    set({ current: null });
    cur.resolve(path);
  },
}));

/**
 * Open the branded folder picker. Resolves to the chosen absolute path,
 * or null if the user cancelled. Drop-in replacement for the previous
 * Electron `dialog.showOpenDialog({ openDirectory })` IPC.
 */
export function pickFolder(options: FolderPickerOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const prev = useFolderPickerStore.getState().current;
    if (prev) prev.resolve(null);
    useFolderPickerStore.setState({ current: { ...options, resolve } });
  });
}
