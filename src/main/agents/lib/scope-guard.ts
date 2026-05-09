/**
 * Server-side enforcement of the "keep PRs small" guidance the bug-fixer
 * prompt asks the LLM to follow. Prompts are unenforceable; an LLM that
 * decides to "helpfully" rewrite 30 files can — and will — do exactly that.
 * This guard inspects the patch the runner produced and rejects the run
 * before the publisher commits.
 *
 * Two checks today:
 *   1. File-count cap (default 5, per-repo overridable).
 *   2. Lockfile/generated-file blacklist (always rejected).
 *
 * Returning `{ ok: false }` is meant to land the run in `failed` with a
 * clear `SCOPE_TOO_WIDE` errorCode + actionable outputSummary, so the
 * user sees exactly what the agent tried to touch.
 */

export interface ScopeGuardOptions {
  maxFiles: number;
}

export interface ScopeGuardResult {
  ok: boolean;
  /** Short reason ("too_many_files", "lockfile_touched", "generated_touched"). */
  reason: string | null;
  /** The files that triggered the failure (or all files when over the cap). */
  offending: string[];
  /** Human-readable detail for outputSummary. */
  detail: string;
}

/**
 * Explicit allowlist of files the bug-fixer is allowed to modify even
 * though they look generated/locked. None today; reserved for future
 * use (e.g. when a fix legitimately bumps a lockfile).
 */
const ALLOWED_PATHS: readonly string[] = [];

/**
 * Lockfiles + manifests we never let the bug-fixer touch. A bug fix that
 * really needs to bump a dependency should be filed by the user, not
 * inferred by the agent. Match is case-insensitive on the basename.
 */
const LOCKFILE_BASENAMES: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'cargo.lock',
  'gemfile.lock',
  'go.sum',
  'poetry.lock',
  'composer.lock',
  'pipfile.lock',
  'mix.lock',
  'flake.lock',
];

/**
 * Path patterns we treat as generated. These cover the most common cases
 * in the wild without needing to parse `.gitattributes` (which a future
 * iteration could honor for repo-specific markings).
 */
const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)dist\//, // build output
  /(^|\/)build\//, // build output
  /(^|\/)\.next\//, // Next.js build
  /(^|\/)out\//, // electron-vite / Next export
  /\.generated\.\w+$/, // *.generated.ts etc.
  /\.pb\.(go|ts|py|rb)$/, // protobuf
  /\.gen\.\w+$/, // *.gen.go etc.
  /(^|\/)__generated__\//,
];

export function checkPatchScope(
  filesChanged: readonly string[],
  opts: ScopeGuardOptions,
): ScopeGuardResult {
  const max = Math.max(1, Math.floor(opts.maxFiles));

  const blacklisted: string[] = [];
  for (const path of filesChanged) {
    if (ALLOWED_PATHS.includes(path)) continue;
    if (isLockfile(path) || isGenerated(path)) {
      blacklisted.push(path);
    }
  }

  if (blacklisted.length > 0) {
    return {
      ok: false,
      reason: 'blacklisted_path',
      offending: blacklisted,
      detail:
        `Bug Fixer attempted to modify ${blacklisted.length} blacklisted file${
          blacklisted.length === 1 ? '' : 's'
        } (lockfiles or generated output): ${blacklisted.slice(0, 3).join(', ')}` +
        (blacklisted.length > 3 ? `, … (+${blacklisted.length - 3} more)` : '') +
        '. These changes were rejected. File the underlying need as a separate issue.',
    };
  }

  if (filesChanged.length > max) {
    return {
      ok: false,
      reason: 'too_many_files',
      offending: [...filesChanged],
      detail:
        `Bug Fixer touched ${filesChanged.length} files (cap is ${max}). ` +
        `Split this into smaller fixes or raise the per-repo \`bug_fixer_max_files\` setting.`,
    };
  }

  return { ok: true, reason: null, offending: [], detail: '' };
}

export function isLockfile(path: string): boolean {
  const base = basename(path).toLowerCase();
  return LOCKFILE_BASENAMES.includes(base);
}

export function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}
