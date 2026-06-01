import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Build the env passed to a CLI runner subprocess.
 *
 * The CLIs (`claude`, `codex`) authenticate themselves via their own login
 * flows (e.g. `claude login`) and read those credentials from the user's
 * home directory or — on macOS — the system keychain. Obelisk does not
 * store API keys; it inherits whatever the CLI already has on disk.
 *
 * We allow-list env vars rather than forwarding `process.env` wholesale,
 * to avoid leaking unrelated host secrets into spawned processes
 * (TECH_DESIGN.md §2.3). The list below covers everything the CLIs (and
 * macOS keychain access) actually need to resolve a signed-in identity:
 *
 *   - PATH / HOME — locating the binary + the user's config dir.
 *   - USER / LOGNAME — required for macOS keychain lookup. Without these,
 *     Claude Code's OAuth token retrieval fails silently and the CLI
 *     prints "Not logged in" even though the user IS signed in. This was
 *     the exact false-positive that surfaced the "Claude Code is signed
 *     out" banner on a logged-in machine.
 *   - SHELL / TERM / TMPDIR / LANG / TZ — generic UX/process plumbing
 *     several CLIs touch (TTY detection, temp file paths, locale).
 *   - XDG_* / APPDATA / USERPROFILE — config-dir resolution on Linux/Win.
 *   - ANTHROPIC_API_KEY / OPENAI_API_KEY — escape hatch for users who
 *     prefer API-key auth over OAuth (and required for the dynamic
 *     model-discovery layer, which calls /v1/models).
 *   - CLAUDE_CODE_* / CODEX_* — both CLIs read flags from their own
 *     namespace; forward the entire prefix so feature flags the user has
 *     in their shell rc behave the same under Obelisk.
 */

const PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'USERPROFILE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

const PREFIXES = ['CLAUDE_CODE_', 'CODEX_', 'ANTHROPIC_', 'OPENAI_'];

export function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    // Defaults so a missing parent var doesn't break the CLI outright.
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
  };
  for (const key of PASSTHROUGH_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (env[key] !== undefined) continue;
    if (PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }

  // Disable the target repo's local git hooks for everything the agent runs.
  // The agent works in an ephemeral worktree with no `node_modules`, so a
  // husky `pre-commit` (lint-staged) or `pre-push` (vitest) hook can't resolve
  // its modules and fails — silently blocking the agent's Prove-It commits
  // (→ "no changes") or its pushes. GIT_CONFIG_* applies at command-line
  // precedence to git invocations in THIS subprocess only; it never writes to
  // or mutates the user's repository config. Pointing core.hooksPath at an
  // empty dir means "no hooks". Skipped if the host already set GIT_CONFIG_*.
  if (process.env['GIT_CONFIG_COUNT'] === undefined) {
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'core.hooksPath';
    env['GIT_CONFIG_VALUE_0'] = emptyHooksDir();
  }

  return env;
}

/** A stable empty directory used as core.hooksPath to disable git hooks. */
function emptyHooksDir(): string {
  const dir = join(tmpdir(), 'obelisk-no-git-hooks');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if we can't create it, git treats a missing hooksPath as
    // "no hooks" anyway, which is exactly what we want.
  }
  return dir;
}
