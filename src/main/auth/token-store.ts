import keytar from 'keytar';

const SERVICE = 'com.obelisk.app';
const ACCOUNT_GITHUB = 'github';
const ACCOUNT_LOGIN = 'github.login';
const ACCOUNT_SCOPES = 'github.scopes';
const ACCOUNT_RUNNER_PREFIX = 'runner.';

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
 * Per-runner API keys (Anthropic / OpenAI). Stored under separate keychain
 * entries so the user can rotate one without affecting the other.
 */
export async function saveRunnerKey(runner: 'claude' | 'codex', key: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_RUNNER_PREFIX + runner, key);
}

export async function loadRunnerKey(runner: 'claude' | 'codex'): Promise<string | null> {
  return safeGet(SERVICE, ACCOUNT_RUNNER_PREFIX + runner);
}

export async function clearRunnerKey(runner: 'claude' | 'codex'): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_RUNNER_PREFIX + runner).catch(() => undefined);
}
