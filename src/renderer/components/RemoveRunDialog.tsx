import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import type { Settings } from '../../shared/types';

export type RemoveAction = 'archive' | 'delete';

interface Props {
  /** Open the dialog with this run's user-facing label as the subtitle. */
  open: boolean;
  runLabel: string;
  /**
   * Initial selection. Pre-fills the radio but the user can still flip it
   * before confirming. Defaults to 'archive' — the safer option.
   */
  initialChoice?: RemoveAction;
  onCancel: () => void;
  /** Called with the chosen action; if `rememberChoice` is true, persist it. */
  onConfirm: (choice: RemoveAction, rememberChoice: boolean) => void;
}

/**
 * Per-card remove dialog. Two options:
 *   - Move to Archive (default) — soft delete, recoverable
 *   - Delete permanently        — hard delete, cascade audit + evidence
 *
 * "Always do this without asking" persists the choice to Settings so future
 * clicks skip the dialog. Toggleable from the Settings screen.
 */
export function RemoveRunDialog({
  open,
  runLabel,
  initialChoice = 'archive',
  onCancel,
  onConfirm,
}: Props): ReactElement | null {
  const [choice, setChoice] = useState<RemoveAction>(initialChoice);
  const [remember, setRemember] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setChoice(initialChoice);
      setRemember(false);
      // Focus the confirm button so Enter commits the default choice.
      setTimeout(() => confirmRef.current?.focus(), 0);
    }
  }, [open, initialChoice]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-panel remove-run-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Remove this run"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="remove-run-header">
          <div className="remove-run-title">Remove this run?</div>
          <div className="remove-run-subtitle" title={runLabel}>
            {runLabel}
          </div>
          <button
            type="button"
            className="btn ghost icon remove-run-close"
            onClick={onCancel}
            aria-label="Close"
          >
            <Icon.Close size={11} />
          </button>
        </header>

        <div className="remove-run-options">
          <label className={`remove-run-option${choice === 'archive' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="remove-run-choice"
              value="archive"
              checked={choice === 'archive'}
              onChange={() => setChoice('archive')}
            />
            <div className="remove-run-option-body">
              <div className="remove-run-option-head">
                <Icon.Archive size={12} />
                <span>Move to Archive</span>
              </div>
              <div className="remove-run-option-desc">
                You can search for it later, restore it, or delete it permanently from the archive.
              </div>
            </div>
          </label>

          <label className={`remove-run-option${choice === 'delete' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="remove-run-choice"
              value="delete"
              checked={choice === 'delete'}
              onChange={() => setChoice('delete')}
            />
            <div className="remove-run-option-body">
              <div className="remove-run-option-head">
                <Icon.Trash size={12} />
                <span>Delete permanently</span>
              </div>
              <div className="remove-run-option-desc">
                The run, its audit log, and saved evidence are gone for good.
              </div>
            </div>
          </label>
        </div>

        <label className="remove-run-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Always do this without asking. (You can change this in Settings.)</span>
        </label>

        <div className="modal-actions remove-run-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${choice === 'delete' ? 'bad' : 'primary'}`}
            onClick={() => onConfirm(choice, remember)}
          >
            {choice === 'archive' ? (
              <>
                <Icon.Archive size={12} /> Move to Archive
              </>
            ) : (
              <>
                <Icon.Trash size={12} /> Delete permanently
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Convenience: read the persisted preference. Returns 'ask' when there's no
 * Settings yet (e.g. during initial load) so the dialog will appear.
 */
export function readRemovePreference(): Settings['cardRemoveAction'] {
  return useStore.getState().settings?.cardRemoveAction ?? 'ask';
}
