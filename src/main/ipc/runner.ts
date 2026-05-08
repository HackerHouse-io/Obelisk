import { probeRunnerAuth } from '../runners/auth-probe';
import type { IpcMap } from '../../shared/types';

/**
 * IPC: probe a runner's sign-in state non-interactively. Used by the
 * "Verify sign-in" button on the auth banner so the user can confirm
 * they fixed an auth issue without launching a real run.
 */
export async function handleRunnerProbeAuth(
  payload: IpcMap['runner:probeAuth']['req'],
): Promise<IpcMap['runner:probeAuth']['res']> {
  return probeRunnerAuth(payload.runner);
}
