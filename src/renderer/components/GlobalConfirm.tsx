import type { ReactElement } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useConfirmStore } from '../state/confirm-store';

/**
 * Mounted once at the Shell level — every async handler can await
 * `showConfirm({...})` and have a branded modal rendered here without
 * threading state of its own. Mirrors GlobalAlert.
 */
export function GlobalConfirm(): ReactElement {
  const current = useConfirmStore((s) => s.current);
  const resolve = useConfirmStore((s) => s.resolve);
  return (
    <ConfirmDialog
      open={current !== null}
      title={current?.title ?? ''}
      body={current?.body}
      confirmLabel={current?.confirmLabel ?? 'OK'}
      cancelLabel={current?.cancelLabel ?? 'Cancel'}
      tone={current?.tone ?? 'primary'}
      {...(current?.confirmIcon ? { confirmIcon: current.confirmIcon } : {})}
      onCancel={() => resolve(false)}
      onConfirm={() => resolve(true)}
    />
  );
}
