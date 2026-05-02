import type { SafetyMode } from '../../shared/types';

/**
 * GitHub OAuth scopes per safety mode (TECH_DESIGN.md §5.2).
 *
 * Note: GitHub's `repo` scope is a superset that includes private-repo
 * read + issues + contents + PRs. For private repos there's no narrower
 * read-only scope, so Observe-only on private repos still requires `repo`
 * — we then enforce read-only at the API client layer (defense in depth).
 *
 * For public repos, `public_repo` is enough at File-issues and above.
 * We always request `repo` here since most users connect at least one
 * private repo over the lifetime of the install. Re-auth for upgrades
 * remains rare in practice.
 */
const SCOPES_BY_MODE: Record<SafetyMode, string[]> = {
  observe: ['read:user', 'repo:status', 'public_repo'],
  issues: ['read:user', 'repo'],
  prs: ['read:user', 'repo'],
  automerge: ['read:user', 'repo'],
};

export function scopesForMode(mode: SafetyMode): string[] {
  return SCOPES_BY_MODE[mode];
}

export function modeRequiresScopeUpgrade(currentScopes: string[], target: SafetyMode): boolean {
  const required = scopesForMode(target);
  return !required.every((s) => currentScopes.includes(s));
}

export function isReadOnlyMode(mode: SafetyMode): boolean {
  return mode === 'observe';
}
