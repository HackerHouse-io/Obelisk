import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import { Octokit } from '@octokit/rest';
import { broadcast } from '../ipc/bus';
import { saveGitHubToken, loadGitHubToken, clearGitHubToken } from './token-store';
import { scopesForMode } from './scope-mapper';
import { ObeliskError } from '../../shared/errors';
import type { SafetyMode } from '../../shared/types';

/**
 * GitHub OAuth Device Flow.
 *
 * The OAuth App's `client_id` is build-time configurable via
 * `OBELISK_GITHUB_CLIENT_ID`. Project distributors register their own
 * GitHub OAuth App ("Enable Device Flow" turned on, no client secret
 * required) and inject the id at packaging time. The open-source repo
 * intentionally has no canonical id baked in.
 */
const CLIENT_ID = process.env['OBELISK_GITHUB_CLIENT_ID'] ?? '';

interface PendingFlow {
  verificationUri: string;
  userCode: string;
  expiresAt: number; // epoch ms
  tokenPromise: Promise<{ token: string; login: string; scopes: string[] }>;
}

let pending: PendingFlow | null = null;

function assertConfigured(): void {
  if (!CLIENT_ID) {
    throw new ObeliskError(
      'AUTH_DENIED',
      'OAuth Device Flow is not available in this build.',
      'Sign in with a Personal Access Token instead — it works for every install.',
    );
  }
}

export function isDeviceFlowConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

export interface SignInResult {
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
}

export async function startSignIn(mode: SafetyMode = 'observe'): Promise<SignInResult> {
  assertConfigured();

  // Cancel any prior in-flight flow.
  pending = null;

  const verificationDeferred = createDeferred<{
    verificationUri: string;
    userCode: string;
    expiresInSeconds: number;
  }>();

  const auth = createOAuthDeviceAuth({
    clientType: 'oauth-app',
    clientId: CLIENT_ID,
    scopes: scopesForMode(mode),
    onVerification(verification) {
      verificationDeferred.resolve({
        verificationUri: verification.verification_uri,
        userCode: verification.user_code,
        expiresInSeconds: verification.expires_in,
      });
    },
  });

  // Kick off the flow; the library polls until the user authorizes.
  const tokenPromise = (async (): Promise<{ token: string; login: string; scopes: string[] }> => {
    const result = await auth({ type: 'oauth' });
    const token = result.token;
    const scopes = result.scopes;
    // Look up the user's login.
    const me = await new Octokit({ auth: token }).users.getAuthenticated();
    const auth0 = { token, login: me.data.login, scopes };
    await saveGitHubToken(auth0);
    broadcast({ type: 'auth.changed', signedIn: true });
    return auth0;
  })();

  // Surface a clean error to the renderer if the flow rejects before
  // verification arrives (rare — usually a network failure).
  tokenPromise.catch((e) => {
    verificationDeferred.reject(e);
  });

  const verification = await verificationDeferred.promise;

  pending = {
    verificationUri: verification.verificationUri,
    userCode: verification.userCode,
    expiresAt: Date.now() + verification.expiresInSeconds * 1000,
    tokenPromise,
  };

  return verification;
}

export async function completeSignIn(): Promise<{ login: string; scope: string[] }> {
  if (!pending) {
    throw new ObeliskError('AUTH_REQUIRED', 'No sign-in flow in progress.');
  }
  try {
    const result = await pending.tokenPromise;
    return { login: result.login, scope: result.scopes };
  } finally {
    pending = null;
  }
}

export async function getStatus(): Promise<{
  signedIn: boolean;
  login?: string;
  scope?: string[];
}> {
  const stored = await loadGitHubToken();
  if (!stored) return { signedIn: false };
  return { signedIn: true, login: stored.login, scope: stored.scopes };
}

export async function signOut(): Promise<void> {
  await clearGitHubToken();
  pending = null;
  broadcast({ type: 'auth.changed', signedIn: false });
}

export async function upgradeScope(target: SafetyMode): Promise<{ scope: string[] }> {
  // Re-runs Device Flow with the broader scope set. Calls startSignIn +
  // immediately awaits completion. The renderer is expected to have
  // surfaced the verification UI before invoking complete; in practice
  // upgradeScope is called from Settings → mode switch and pairs with
  // a separate auth:signIn / auth:complete cycle.
  await startSignIn(target);
  const result = await completeSignIn();
  return { scope: result.scope };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
