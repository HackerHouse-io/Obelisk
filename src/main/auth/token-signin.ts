import { Octokit } from '@octokit/rest';
import { broadcast } from '../ipc/bus';
import { saveGitHubToken } from './token-store';
import { ObeliskError } from '../../shared/errors';

/**
 * Authenticate with a GitHub Personal Access Token.
 *
 * This is the default sign-in path. Validation calls `users.getAuthenticated`,
 * which both confirms the token works and tells us the login. Granted scopes
 * come back in the `x-oauth-scopes` response header (classic PATs); fine-
 * grained tokens omit it, in which case we trust GitHub to enforce per-call
 * permissions and skip the scope check.
 */
export async function signInWithToken(token: string): Promise<{ login: string; scopes: string[] }> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new ObeliskError('AUTH_DENIED', 'Paste a GitHub token to continue.');
  }

  let login: string;
  let scopes: string[] = [];
  try {
    const client = new Octokit({ auth: trimmed, userAgent: 'obelisk-app/0.0.1' });
    const res = await client.users.getAuthenticated();
    login = res.data.login;
    const header = res.headers['x-oauth-scopes'];
    if (typeof header === 'string' && header.trim().length > 0) {
      scopes = header
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) {
      throw new ObeliskError(
        'AUTH_DENIED',
        'GitHub rejected that token.',
        'Make sure you copied the whole token and that it has not expired.',
      );
    }
    throw new ObeliskError(
      'AUTH_DENIED',
      'Could not validate the token with GitHub.',
      (e as Error).message,
    );
  }

  // Classic PATs report scopes; reject early if the user generated one
  // without `repo` so they don't hit a confusing permission failure later.
  // Fine-grained PATs return no header — accept and let API calls fail
  // with a clear 403 if permissions are insufficient.
  if (scopes.length > 0 && !scopes.includes('repo') && !scopes.includes('public_repo')) {
    throw new ObeliskError(
      'AUTH_DENIED',
      'Token is missing the `repo` scope.',
      'Generate a new token with `repo` (and `workflow` if your repo uses Actions).',
    );
  }

  await saveGitHubToken({ token: trimmed, login, scopes });
  broadcast({ type: 'auth.changed', signedIn: true });
  return { login, scopes };
}
