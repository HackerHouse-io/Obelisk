import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { matchesAnyGlob } from './coverage-map';
import { collectFeatures } from '../test-plans/heuristic';

export interface FeatureCandidate {
  label: string;
  globs: string[];
  filesMatched: number;
}

const MIN_FILES_PER_LABEL = 3;
const MAX_LABELS = 12;
/**
 * If a top-level feature dir has at least this many files AND at least two
 * sub-dirs that each meet MIN_FILES_PER_LABEL, we split it into sub-features
 * instead of emitting a single bucket. Lets a repo laid out as
 * `src/wealthlab/{auth,charts,data}/...` show 3 sub-feature axes on the
 * radar instead of one giant `wealthlab` bucket.
 */
const SUB_FEATURE_SPLIT_THRESHOLD = 8;

const SKIP_LABELS = new Set([
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  'public',
  'static',
  'docs',
  'doc',
  'tests',
  'test',
  'scripts',
  'vendor',
  'qa',
  'evidence',
]);

const CODE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|swift|kt|java|py|rb|go|rs|cs|php|m|mm|css|scss|less|html|vue|svelte)$/i;

/**
 * Walk the repo's tracked files and propose coverage labels. Same logic
 * the Coverage screen uses when bootstrapping `qa/coverage-map.md`, but
 * also called on every coverage report build so the radar always reflects
 * the live codebase — not just whatever labels the user happened to write
 * into the map file.
 */
export async function scanRepoFeatures(repoPath: string): Promise<FeatureCandidate[]> {
  const trackedFiles = await listTrackedFiles(repoPath);
  return scanFromTrackedFiles(repoPath, trackedFiles);
}

/** Synchronous variant when the caller already has the tracked-files list. */
export function scanFromTrackedFiles(repoPath: string, trackedFiles: string[]): FeatureCandidate[] {
  const codeFiles = trackedFiles.filter(isCodeFile);
  const { groups, splitParents } = groupBySegment(codeFiles);

  const out = new Map<string, FeatureCandidate>();

  function push(label: string, globs: string[]): void {
    const norm = normalizeLabel(label);
    if (!norm || SKIP_LABELS.has(norm)) return;
    // Skip parents we've already split into sub-features — re-emitting them
    // would clobber the sub-feature labels and undo the split.
    if (splitParents.has(norm)) return;
    const unique = Array.from(new Set(globs.map((g) => g.trim()).filter(Boolean)));
    if (unique.length === 0) return;
    const filesMatched = trackedFiles.filter((p) => matchesAnyGlob(p, unique)).length;
    const existing = out.get(norm);
    if (!existing || filesMatched > existing.filesMatched) {
      out.set(norm, { label: norm, globs: unique, filesMatched });
    }
  }

  // 1. Directory-grouped features (file-tracked, language-agnostic).
  for (const g of groups) {
    if (g.count < MIN_FILES_PER_LABEL) continue;
    push(g.name, [`${g.dir}/**`]);
  }

  // 2. Heuristic features (renderer screens, README headings) — they win
  //    when their globs match more files than the directory grouping.
  try {
    for (const raw of collectFeatures(repoPath)) {
      const globs = proposeGlobsForFeature(repoPath, raw);
      if (globs.length === 0) continue;
      push(raw, globs);
    }
  } catch {
    // collectFeatures is best-effort; rely on the directory grouping above.
  }

  // 3. Drop labels that match zero files; keep at most MAX_LABELS.
  let result = Array.from(out.values()).filter((c) => c.filesMatched > 0);
  result.sort((a, b) => b.filesMatched - a.filesMatched);

  if (result.length === 0 && codeFiles.length > 0) {
    result = [{ label: 'app', globs: ['**/*'], filesMatched: codeFiles.length }];
  }

  return result.slice(0, MAX_LABELS);
}

interface DirGroup {
  name: string;
  dir: string;
  count: number;
}

interface GroupResult {
  groups: DirGroup[];
  /** Normalized parent labels that were split into sub-features. */
  splitParents: Set<string>;
}

function groupBySegment(codeFiles: string[]): GroupResult {
  // Count at the natural 2-segment depth first ("feature level"), then at
  // the 3-segment depth ("sub-feature level"). A big feature gets split
  // into its sub-features when the parent is large and has enough viable
  // children — otherwise we keep it whole.
  const featureCounts = new Map<string, number>(); // dir → file count
  const subCounts = new Map<string, Map<string, number>>(); // parent → sub-dir → file count

  for (const file of codeFiles) {
    const segs = file.split('/');
    if (segs.length < 2) continue;

    let dir: string;
    if (
      (segs[0] === 'src' || segs[0] === 'app' || segs[0] === 'apps' || segs[0] === 'lib') &&
      segs.length >= 3
    ) {
      dir = `${segs[0]}/${segs[1]}`;
      // Record sub-feature when there's enough depth: src/<feature>/<sub>/file.
      if (segs.length >= 4) {
        const subDir = `${segs[0]}/${segs[1]}/${segs[2]}`;
        let bucket = subCounts.get(dir);
        if (!bucket) {
          bucket = new Map();
          subCounts.set(dir, bucket);
        }
        bucket.set(subDir, (bucket.get(subDir) ?? 0) + 1);
      }
    } else {
      dir = segs[0]!;
    }
    featureCounts.set(dir, (featureCounts.get(dir) ?? 0) + 1);
  }

  const out: DirGroup[] = [];
  const splitParents = new Set<string>();
  for (const [dir, count] of featureCounts) {
    const segs = dir.split('/');
    const parentName = segs.length >= 2 ? segs[1]! : segs[0]!;

    // Should we split this feature into sub-features?
    const subs = subCounts.get(dir);
    const viableSubs = subs
      ? Array.from(subs.entries()).filter(([, c]) => c >= MIN_FILES_PER_LABEL)
      : [];
    if (count >= SUB_FEATURE_SPLIT_THRESHOLD && viableSubs.length >= 2) {
      splitParents.add(normalizeLabel(parentName));
      for (const [subDir, subCount] of viableSubs) {
        const subSegs = subDir.split('/');
        const subName = subSegs[subSegs.length - 1]!;
        out.push({ name: subName, dir: subDir, count: subCount });
      }
    } else {
      out.push({ name: parentName, dir, count });
    }
  }

  out.sort((a, b) => b.count - a.count);
  return { groups: out, splitParents };
}

function proposeGlobsForFeature(repoPath: string, feature: string): string[] {
  const lower = feature.toLowerCase();
  const candidates = [
    `src/renderer/screens/${feature}.tsx`,
    `src/renderer/screens/${feature}/**`,
    `src/main/${lower}/**`,
    `src/main/agents/${lower}/**`,
    `src/features/${lower}/**`,
    `src/${lower}/**`,
    `app/${lower}/**`,
    `apps/${lower}/**`,
  ];
  const globs: string[] = [];
  for (const c of candidates) {
    const prefix = c.split('*')[0]!.replace(/\/$/, '');
    if (!prefix) continue;
    try {
      if (existsSync(join(repoPath, prefix))) globs.push(c);
    } catch {
      // ignore
    }
  }
  return Array.from(new Set(globs));
}

function isCodeFile(path: string): boolean {
  if (
    path.startsWith('node_modules/') ||
    path.startsWith('out/') ||
    path.startsWith('dist/') ||
    path.startsWith('build/') ||
    path.startsWith('.git/') ||
    path.startsWith('coverage/')
  ) {
    return false;
  }
  return CODE_EXT_RE.test(path);
}

export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function listTrackedFiles(repoPath: string): Promise<string[]> {
  try {
    const out = await simpleGit(repoPath).raw(['ls-files']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(
        (p) => !p.startsWith('node_modules/') && !p.startsWith('out/') && !p.startsWith('dist/'),
      );
  } catch {
    return [];
  }
}
