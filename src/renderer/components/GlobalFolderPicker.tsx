import type { ReactElement } from 'react';
import { FolderPickerDialog } from './FolderPickerDialog';
import { useFolderPickerStore } from '../state/folder-picker-store';

/**
 * Mounted once at Shell. Awaits `pickFolder()` from anywhere in the
 * app and renders the branded folder picker in place of the OS
 * folder-selection dialog.
 */
export function GlobalFolderPicker(): ReactElement {
  const current = useFolderPickerStore((s) => s.current);
  const resolve = useFolderPickerStore((s) => s.resolve);
  return (
    <FolderPickerDialog
      open={current !== null}
      title={current?.title ?? 'Pick a folder'}
      confirmLabel={current?.confirmLabel ?? 'Choose'}
      onCancel={() => resolve(null)}
      onConfirm={(path) => resolve(path)}
    />
  );
}
