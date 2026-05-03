import { startSignIn, completeSignIn, getStatus, signOut, upgradeScope } from '../auth/device-flow';
import { invalidateGithubClient } from '../github/client';
import type { IpcMap } from '../../shared/types';

export async function handleAuthStatus(): Promise<IpcMap['auth:status']['res']> {
  return getStatus();
}

export async function handleAuthSignIn(): Promise<IpcMap['auth:signIn']['res']> {
  return startSignIn();
}

export async function handleAuthComplete(): Promise<IpcMap['auth:complete']['res']> {
  invalidateGithubClient();
  return completeSignIn();
}

export async function handleAuthUpgradeScope(
  payload: IpcMap['auth:upgradeScope']['req'],
): Promise<IpcMap['auth:upgradeScope']['res']> {
  invalidateGithubClient();
  return upgradeScope(payload.to);
}

export async function handleAuthSignOut(): Promise<IpcMap['auth:signOut']['res']> {
  await signOut();
  invalidateGithubClient();
  return { ok: true };
}
