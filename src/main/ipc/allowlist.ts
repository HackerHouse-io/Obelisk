import { listAllowlist, addToAllowlist, removeFromAllowlist } from '../db/allowlist';
import { getRepo } from '../db/repos';
import { getGithub } from '../github/client';
import { loadGitHubToken } from '../auth/token-store';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap } from '../../shared/types';

export async function handleAllowlistList(
  payload: IpcMap['allowlist:list']['req'],
): Promise<IpcMap['allowlist:list']['res']> {
  if (!getRepo(payload.repoId)) {
    throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  }
  return listAllowlist(payload.repoId);
}

/**
 * Validate the login exists on GitHub before adding it to the allowlist —
 * stops the user from adding typos that would never trigger anyway.
 */
export async function handleAllowlistAdd(
  payload: IpcMap['allowlist:add']['req'],
): Promise<IpcMap['allowlist:add']['res']> {
  if (!getRepo(payload.repoId)) {
    throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  }
  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before editing the allowlist.');
  }
  try {
    await gh.users.getByUsername({ username: payload.login });
  } catch (e: unknown) {
    const status = (e as { status?: number }).status;
    if (status === 404) {
      throw new ObeliskError(
        'INVALID_INPUT',
        `GitHub user @${payload.login} does not exist.`,
        'Double-check the spelling.',
      );
    }
    throw e;
  }
  const stored = await loadGitHubToken();
  addToAllowlist(payload.repoId, payload.login, stored?.login ?? 'unknown');
  return { ok: true };
}

export async function handleAllowlistRemove(
  payload: IpcMap['allowlist:remove']['req'],
): Promise<IpcMap['allowlist:remove']['res']> {
  if (!getRepo(payload.repoId)) {
    throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  }
  const stored = await loadGitHubToken();
  if (stored?.login && payload.login.toLowerCase() === stored.login.toLowerCase()) {
    throw new ObeliskError(
      'INVALID_INPUT',
      'Cannot remove the connected GitHub account from its own allowlist.',
      'Sign out instead, or pick a different connected account.',
    );
  }
  removeFromAllowlist(payload.repoId, payload.login);
  return { ok: true };
}
