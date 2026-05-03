/**
 * Build the env passed to a CLI runner subprocess.
 *
 * The CLIs (`claude`, `codex`) authenticate themselves via their own login
 * flows (e.g. `claude login`) and read those credentials from the user's
 * home directory. Obelisk does not store API keys — it inherits whatever
 * the CLI already has on disk.
 *
 * Allow-list approach: only forward the env vars the CLI actually needs.
 * Skipping the rest avoids leaking unrelated host secrets into spawned
 * processes (TECH_DESIGN.md §2.3).
 */
export function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
  };
  for (const k of ['XDG_CONFIG_HOME', 'APPDATA', 'USERPROFILE']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}
