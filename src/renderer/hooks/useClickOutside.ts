import { useEffect, type RefObject } from 'react';

/**
 * Close-on-outside-click + Escape. Wires `mousedown` on document and
 * `keydown` for Escape; both no-op when `open` is false. The `ref`
 * should wrap the element that's allowed to receive clicks without
 * triggering close.
 */
export function useClickOutside(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose]);
}
