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

export async function saveGitHubToken(auth: StoredAuth): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT_GITHUB, auth.token);
  await keytar.setPassword(SERVICE, ACCOUNT_LOGIN, auth.login);
  await keytar.setPassword(SERVICE, ACCOUNT_SCOPES, JSON.stringify(auth.scopes));
}

export async function loadGitHubToken(): Promise<StoredAuth | null> {
  const token = await keytar.getPassword(SERVICE, ACCOUNT_GITHUB);
  if (!token) return null;
  const login = (await keytar.getPassword(SERVICE, ACCOUNT_LOGIN)) ?? '';
  const scopesRaw = await keytar.getPassword(SERVICE, ACCOUNT_SCOPES);
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
  return keytar.getPassword(SERVICE, ACCOUNT_RUNNER_PREFIX + runner);
}

export async function clearRunnerKey(runner: 'claude' | 'codex'): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT_RUNNER_PREFIX + runner).catch(() => undefined);
}
