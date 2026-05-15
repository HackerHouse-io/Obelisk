import type { ReactElement } from 'react';
import { AlertDialog } from '../ui/AlertDialog';
import { useAlertStore } from '../state/alert-store';

/**
 * Mounted once at the Shell level — every screen / IPC handler can
 * surface a branded alert via showAlert / showApiAlert without
 * threading state of its own. Replaces the previous window.alert()
 * pattern app-wide.
 */
export function GlobalAlert(): ReactElement {
  const current = useAlertStore((s) => s.current);
  const dismiss = useAlertStore((s) => s.dismiss);
  return (
    <AlertDialog
      open={current !== null}
      title={current?.title ?? ''}
      body={current?.body}
      {...(current?.hint ? { hint: current.hint } : {})}
      {...(current?.confirmLabel ? { confirmLabel: current.confirmLabel } : {})}
      onClose={dismiss}
    />
  );
}
