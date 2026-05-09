import keytar from 'keytar';

const SERVICE = 'com.obelisk.app';
const ACCOUNT_GITHUB = 'github';
const ACCOUNT_LOGIN = 'github.login';
const ACCOUNT_SCOPES = 'github.scopes';

export interface StoredAuth {
  token: string;
  login: string;
  scopes: string[];
}

/**
 * keytar requires an OS keyring (Keychain on macOS, Credential Manager on
 * Windows, libsecret + a running Secret Service on Linux). On headless or
 * sandboxed environments — most notably CI runners — the read calls throw
 * "org.freedesktop.secrets was not provided by any .service files".
 *
 * For Obelisk, "no keyring" is observationally identical to "no token
 * stored": the renderer routes the user to the Connect wizard either way.
 * `safeGet` swallows those errors and returns null so downstream code
 * doesn't have to special-case the test/CI environment.
 *
 * Writes (`set`/`delete`) still throw — those failures are user-visible
 * (sign-in actually broke), and we don't want to silently lose tokens.
 */
async function safeGet(service: string, account: string): Promise<string | null> {
  try {
    return await keytar.getPassword(service, account);
  } catch {
    return null;
  }
}

export async function saveGitHubToken(auth: StoredAuth): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_GITHUB, auth.token);
  await keytar.setPassword(SERVICE, ACCOUNT_LOGIN, auth.login);
  await keytar.setPassword(SERVICE, ACCOUNT_SCOPES, JSON.stringify(auth.scopes));
}

export async function loadGitHubToken(): Promise<StoredAuth | null> {
  const token = await safeGet(SERVICE, ACCOUNT_GITHUB);
  if (!token) return null;
  const login = (await safeGet(SERVICE, ACCOUNT_LOGIN)) ?? '';
  const scopesRaw = await safeGet(SERVICE, ACCOUNT_SCOPES);
  let scopes: string[] = [];
  if (scopesRaw) {
    try {
      const parsed: unknown = JSON.parse(scopesRaw);
      if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      // ignore — fall back to []
    }
  }
  return { token, login, scopes };
}

export async function clearGitHubToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_GITHUB).catch(() => undefined);
  await keytar.deletePassword(SERVICE, ACCOUNT_LOGIN).catch(() => undefined);
  await keytar.deletePassword(SERVICE, ACCOUNT_SCOPES).catch(() => undefined);
}

/**
 * The connected GitHub user's login (lowercased). Used by claim-on-github
 * to assign issues to the right user, by clearClaimSignals to remove just
 * that assignee on cleanup, and by the cross-installation guard to
 * recognise a sibling Obelisk install.
 *
 * The keychain caches the login at sign-in time, so the fast path is a
 * local OS call. When the keychain doesn't have it (older sign-ins, test
 * harnesses, or when `OBELISK_GITHUB_BASE_URL` points at a stub server),
 * we fall back to `gh.users.getAuthenticated` and cache the result for
 * the lifetime of the process.
 */
let authedLoginCache: string | null = null;
let authedLoginToken: string | null = null;

export async function getAuthedLogin(): Promise<string | null> {
  // Test/e2e override: explicit env var beats keychain so an isolated
  // harness doesn't depend on whatever login the developer's local
  // Keychain happens to hold from a prior real sign-in.
  const override = process.env['OBELISK_AUTHED_LOGIN'];
  if (override && override.length > 0) return override.toLowerCase();

  const stored = await loadGitHubToken();
  if (!stored) {
    authedLoginCache = null;
    authedLoginToken = null;
    return null;
  }
  if (stored.login) return stored.login.toLowerCase();

  // Reset the cache when the user signs in/out.
  if (authedLoginCache && authedLoginToken === stored.token) return authedLoginCache;

  try {
    const { getGithub } = await import('../github/client');
    const gh = await getGithub();
    if (!gh) return null;
    const resp = await gh.users.getAuthenticated();
    const login = resp.data.login?.toLowerCase() ?? null;
    if (login) {
      authedLoginCache = login;
      authedLoginToken = stored.token;
    }
    return login;
  } catch {
    return null;
  }
}

/** Test hook: clear the in-process cache between fixtures. */
export function _resetAuthedLoginCacheForTesting(): void {
  authedLoginCache = null;
  authedLoginToken = null;
}
