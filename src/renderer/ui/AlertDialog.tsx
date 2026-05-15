import { useEffect, type ReactElement, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  body?: ReactNode;
  /** Optional secondary line (rendered dimmer) — used for ObeliskError hints. */
  hint?: ReactNode;
  /** Defaults to "OK". */
  confirmLabel?: string;
  onClose: () => void;
}

/**
 * Single-button informational modal. Replaces window.alert() at call
 * sites where a backend error needs to be surfaced with our own
 * branding rather than the OS-native dialog.
 */
export function AlertDialog({
  open,
  title,
  body,
  hint,
  confirmLabel = 'OK',
  onClose,
}: Props): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        {body ? <div className="modal-body">{body}</div> : null}
        {hint ? <div className="modal-body modal-hint">{hint}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
