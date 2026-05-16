import { create } from 'zustand';
import type { IconName } from '../icons';

export interface ConfirmPayload {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  confirmIcon?: IconName;
}

interface ConfirmRequest extends ConfirmPayload {
  resolve: (ok: boolean) => void;
}

interface ConfirmStoreState {
  current: ConfirmRequest | null;
  resolve: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmStoreState>((set, get) => ({
  current: null,
  resolve: (ok) => {
    const cur = get().current;
    if (!cur) return;
    set({ current: null });
    cur.resolve(ok);
  },
}));

/**
 * Promise-returning branded confirm. Mirrors the imperative ergonomics of
 * `window.confirm()` — `const ok = await showConfirm({ title, body })` —
 * but renders through GlobalConfirm so the dialog matches the rest of
 * the app instead of the OS chrome.
 */
export function showConfirm(payload: ConfirmPayload): Promise<boolean> {
  return new Promise((resolve) => {
    // If another confirm is already open, resolve it as cancelled before
    // taking its place. Two stacked confirms would lose the previous
    // resolver and leak a pending promise.
    const prev = useConfirmStore.getState().current;
    if (prev) prev.resolve(false);
    useConfirmStore.setState({ current: { ...payload, resolve } });
  });
}
