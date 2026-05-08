import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-repo `qa/coverage-map.md` file maps human-friendly labels (the kind
 * users put on test cases — `auth`, `checkout`, `onboarding`) to file globs
 * (the precise paths the coverage screen and aggregator need).
 *
 * Expected format — a markdown list, one label per line:
 *
 *     # Coverage map
 *
 *     - `auth`: `src/auth/**`, `src/middleware/auth*.ts`
 *     - `checkout`: `src/checkout/**`
 *     - `onboarding`: `src/onboarding/**`, `src/RootView.swift`
 *
 * The loader is forgiving: prose between list items is ignored, label and
 * glob can be wrapped in backticks or not, separators can be `:` or `→`.
 */

export type CoverageMap = Map<string, string[]>;

/** Where the map file lives inside a repo. */
export const COVERAGE_MAP_PATH = ['qa', 'coverage-map.md'] as const;

/**
 * Read & parse the repo's `qa/coverage-map.md`. Returns an empty Map if the
 * file is missing or malformed — callers should fall back to a substring
 * matcher in that case.
 */
export function loadCoverageMap(repoLocalPath: string): CoverageMap {
  const path = join(repoLocalPath, ...COVERAGE_MAP_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return new Map();
  }
  return parseCoverageMap(raw);
}

export function parseCoverageMap(raw: string): CoverageMap {
  const map: CoverageMap = new Map();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s+/, '').trim();
    if (!line) continue;
    // Accept `auth: glob, glob2` or `auth → glob, glob2` (and the same with
    // each side optionally wrapped in backticks).
    const m = /^`?([A-Za-z0-9_\-./]+)`?\s*(?::|→|->)\s*(.+)$/.exec(line);
    if (!m) continue;
    const label = m[1]!.toLowerCase();
    const globs = m[2]!
      .split(',')
      .map((g) => g.trim().replace(/^`+|`+$/g, ''))
      .filter(Boolean);
    if (globs.length === 0) continue;
    map.set(label, globs);
  }
  return map;
}

/**
 * Resolve a list of scope labels to globs using the map; for labels missing
 * from the map, fall back to a literal substring match against any path
 * (i.e. label `auth` matches `src/auth/session.ts`). Returns a flat list of
 * globs / substrings — caller passes them through `matchesAnyGlob` below.
 */
export function resolveScopeToGlobs(scope: string[], map: CoverageMap): string[] {
  const out: string[] = [];
  for (const label of scope) {
    const lower = label.toLowerCase();
    const mapped = map.get(lower);
    if (mapped) {
      out.push(...mapped);
    } else {
      // Fallback: `auth` becomes `**/auth/**` plus a literal substring.
      out.push(`**/${lower}/**`, `**/${lower}*`, `**/*${lower}*`);
    }
  }
  return out;
}

/**
 * Tiny glob matcher. Supports `*`, `**`, and literal segments. Sufficient
 * for the patterns that show up in real `coverage-map.md` files.
 */
export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(filePath, g));
}

export function matchesGlob(filePath: string, glob: string): boolean {
  // Hand-roll a tiny tokenizer: `**` becomes `.*`, `*` becomes `[^/]*`,
  // everything else gets regex-escaped. Avoids chained replace() pitfalls
  // around the literal characters that regex-escape produces.
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      pattern += '\\' + c;
    } else {
      pattern += c;
    }
  }
  const re = new RegExp('^' + pattern + '$');
  return re.test(filePath);
}
