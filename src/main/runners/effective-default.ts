import { getSetting } from '../db/settings';
import type { Repo, RunnerKind } from '../../shared/types';

/**
 * Read a Settings value, falling back gracefully when the DB isn't available
 * (tests without migrations, etc.). Production always has a healthy DB; this
 * wrapper just keeps Settings reads from crashing the call site.
 */
function readSetting<T>(key: string): T | null {
  try {
    const v = getSetting<T>('app', key);
    return v ?? null;
  } catch {
    return null;
  }
}

/**
 * The runner Obelisk should actually use for this repo.
 *
 * Resolution order:
 *  1. Global Settings → `app:defaultRunner` (what the user set in Settings).
 *  2. The per-repo `default_runner` column captured at connect time.
 *
 * Without #1 the Settings UI is a lie — it would only affect newly-connected
 * repos.
 */
export function effectiveDefaultRunner(repo: Repo): RunnerKind {
  return readSetting<RunnerKind>('defaultRunner') ?? repo.defaultRunner;
}

/**
 * The CLI model name Obelisk should pass to a runner. Returns `null` to mean
 * "let the CLI pick its own default" — required for ChatGPT-account Codex
 * sign-ins, which reject any explicit `--model` flag.
 *
 * We never hardcode model names: identifiers (`gpt-5`, `sonnet-4.6`, etc.)
 * change frequently and are account-dependent. The user types the model into
 * Settings → Default Models; we pass it through verbatim, or omit when blank.
 */
export function effectiveDefaultModel(kind: RunnerKind): string | null {
  const value = readSetting<string>(kind === 'codex' ? 'codexModel' : 'claudeModel');
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve a per-call model override against Settings. Single source of truth
 * for the three-way semantics:
 *   - explicit non-empty string → that exact model name
 *   - explicit `null` or blank/whitespace string → force CLI default (no flag)
 *   - `undefined` → fall through to Settings, then CLI default
 *
 * Used by every code path that builds runner args (plan generator + prompt
 * compiler), so the override semantics are identical everywhere.
 */
export function resolveRunnerModel(
  kind: RunnerKind,
  override: string | null | undefined,
): string | null {
  if (override === null) return null;
  let resolved: string | null;
  if (override !== undefined) {
    const trimmed = override.trim();
    resolved = trimmed.length > 0 ? trimmed : null;
  } else {
    resolved = effectiveDefaultModel(kind);
  }
  if (resolved === null) return null;
  return kind === 'claude' ? normalizeClaudeModelId(resolved) : resolved;
}

/**
 * Map version-suffixed shorthand (`sonnet-4-6`, `opus-4-7`, `haiku-4-5`) to
 * the full pinned ids the `claude` CLI actually accepts. Earlier curated
 * lists shipped the shorthand and it persisted into user Settings; the CLI
 * exits 1 with "model does not exist" if we pass it through. Aliases
 * (`sonnet`/`opus`/`haiku`) and full ids (`claude-sonnet-4-6`) are
 * passed through unchanged.
 */
function normalizeClaudeModelId(id: string): string {
  if (/^claude-/.test(id)) return id;
  const m = /^(sonnet|opus|haiku)-(.+)$/.exec(id);
  if (m) return `claude-${m[1]}-${m[2]}`;
  return id;
}
