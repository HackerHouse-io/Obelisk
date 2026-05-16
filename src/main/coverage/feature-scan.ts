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
  const groups = groupBySegment(codeFiles);

  const out = new Map<string, FeatureCandidate>();

  function push(label: string, globs: string[]): void {
    const norm = normalizeLabel(label);
    if (!norm || SKIP_LABELS.has(norm)) return;
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

function groupBySegment(codeFiles: string[]): DirGroup[] {
  const counts = new Map<string, { dir: string; count: number }>();
  for (const file of codeFiles) {
    const segs = file.split('/');
    if (segs.length < 2) continue;
    let dir = segs[0]!;
    if (
      (segs[0] === 'src' || segs[0] === 'app' || segs[0] === 'apps' || segs[0] === 'lib') &&
      segs.length >= 3
    ) {
      dir = `${segs[0]}/${segs[1]}`;
    }
    const slot = counts.get(dir);
    if (slot) slot.count += 1;
    else counts.set(dir, { dir, count: 1 });
  }
  const out: DirGroup[] = [];
  for (const { dir, count } of counts.values()) {
    const segs = dir.split('/');
    const name = segs.length >= 2 ? segs[1]! : segs[0]!;
    out.push({ name, dir, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
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
