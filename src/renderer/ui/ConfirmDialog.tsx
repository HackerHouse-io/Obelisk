import { useEffect, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';

interface Props {
  open: boolean;
  title: string;
  body?: ReactNode;
  /** Defaults to "Cancel". Set null to hide the cancel button entirely. */
  cancelLabel?: string | null;
  /** The primary action label and handler. */
  confirmLabel: string;
  confirmIcon?: IconName;
  /** Visual treatment of the confirm button. */
  tone?: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  cancelLabel = 'Cancel',
  confirmLabel,
  confirmIcon,
  tone = 'primary',
  onCancel,
  onConfirm,
}: Props): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const ConfirmIcon = confirmIcon ? Icon[confirmIcon] : null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-panel"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        {body ? <div className="modal-body">{body}</div> : null}
        <div className="modal-actions">
          {cancelLabel !== null ? (
            <button type="button" className="btn ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {ConfirmIcon ? <ConfirmIcon size={12} /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
