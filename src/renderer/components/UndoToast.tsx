import { useEffect, useRef, useState, type ReactElement } from 'react';

interface Props {
  message: string;
  /** Called if the user clicks "Undo" before the timeout fires. */
  onUndo: () => void;
  /** Called when the toast finishes its lifetime (timeout or after Undo). */
  onClose: () => void;
  /** Lifetime in ms. Default 5000. */
  durationMs?: number;
}

/**
 * Bottom-of-screen transient toast with a single "Undo" affordance.
 * Used as the immediate recovery for one-click destructive UI like
 * "Not a bug" — the user has 5 seconds to take it back before the
 * action is treated as final.
 *
 * The toast also unmounts itself when the user clicks Undo, so the
 * caller doesn't need to track open state separately.
 */
export function UndoToast({ message, onUndo, onClose, durationMs = 5000 }: Props): ReactElement {
  const [progress, setProgress] = useState(1);
  const undoneRef = useRef(false);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const elapsed = now - start;
      const ratio = Math.max(0, 1 - elapsed / durationMs);
      setProgress(ratio);
      if (ratio > 0 && !undoneRef.current) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    const t = setTimeout(() => {
      if (undoneRef.current) return;
      onClose();
    }, durationMs);
    return (): void => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [durationMs, onClose]);

  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span className="undo-toast-message">{message}</span>
      <button
        type="button"
        className="undo-toast-button"
        onClick={() => {
          undoneRef.current = true;
          onUndo();
          onClose();
        }}
      >
        Undo
      </button>
      <span
        className="undo-toast-progress"
        aria-hidden="true"
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
}
