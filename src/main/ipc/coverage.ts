import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { IpcMap } from '../../shared/types';
import { ObeliskError } from '../../shared/errors';
import { buildCoverageReport } from '../coverage/aggregate';
import { matchesAnyGlob, parseCoverageMap } from '../coverage/coverage-map';
import { scanFromTrackedFiles } from '../coverage/feature-scan';
import { startMapGenerationJob } from '../coverage/generate-map';
import { dismissJob, listJobs } from '../coverage/jobs';
import { getRepo } from '../db/repos';

export async function handleCoverageList(
  payload: IpcMap['coverage:list']['req'],
): Promise<IpcMap['coverage:list']['res']> {
  return buildCoverageReport(payload.repoId);
}

/**
 * Bootstrap or regenerate `qa/coverage-map.md`.
 *
 *   - `commit: false / omitted` → return proposed entries for preview only
 *   - `commit: true, no map yet` → write the scanner's proposals
 *   - `commit: true, force: true, map exists` → MERGE: write the union of
 *       the existing map entries (preserved verbatim) and any newly-detected
 *       features from the live scan. Existing entries win on label collisions
 *       so user edits to globs are preserved.
 *   - `commit: true, no force, map exists with content` → refuse to overwrite
 *       (initial bootstrap path; safe default)
 *
 * Regenerate is **additive by design** — clicking it never drops the labels
 * the user already curated, only layers new ones on top. Removing a stale
 * label means editing `qa/coverage-map.md` directly.
 */
export async function handleCoverageBootstrapMap(
  payload: IpcMap['coverage:bootstrapMap']['req'],
): Promise<IpcMap['coverage:bootstrapMap']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);

  const trackedFiles = await listTrackedFiles(repo.localPath);
  const scanned = scanFromTrackedFiles(repo.localPath, trackedFiles);

  if (!payload.commit) {
    return { proposals: scanned, written: false };
  }

  const mapDir = join(repo.localPath, 'qa');
  const mapPath = join(mapDir, 'coverage-map.md');

  // Read the existing map (if any) so we can preserve labels the user
  // already curated. parseCoverageMap returns an empty Map for stale /
  // unparseable / missing files — those are safe to overwrite.
  let existingEntries: { label: string; globs: string[] }[] = [];
  let existingIsUsable = false;
  if (existsSync(mapPath)) {
    try {
      const existing = parseCoverageMap(readFileSync(mapPath, 'utf8'));
      if (existing.size > 0) {
        existingIsUsable = true;
        for (const [label, globs] of existing) existingEntries.push({ label, globs });
      }
    } catch {
      // unparseable → treat as absent.
    }
  }

  // Non-force write against a usable existing map: refuse (initial bootstrap
  // path won't clobber a hand-edited file).
  if (existingIsUsable && !payload.force) {
    return {
      proposals: scanned,
      written: false,
      reason: 'coverage-map.md already exists — edit it directly to refine globs.',
    };
  }

  // Build the final proposal list:
  //   - existing entries (preserved verbatim — globs and all)
  //   - + any scanner-detected labels NOT already in the map
  const finalByLabel = new Map<string, { label: string; globs: string[]; filesMatched: number }>();
  for (const e of existingEntries) {
    const filesMatched = trackedFiles.filter((p) => matchesAnyGlob(p, e.globs)).length;
    finalByLabel.set(e.label, { label: e.label, globs: e.globs, filesMatched });
  }
  for (const s of scanned) {
    if (finalByLabel.has(s.label)) continue;
    finalByLabel.set(s.label, s);
  }

  const finalProposals = Array.from(finalByLabel.values()).sort(
    (a, b) => b.filesMatched - a.filesMatched,
  );

  if (finalProposals.length === 0) {
    throw new ObeliskError(
      'INVALID_INPUT',
      "Couldn't detect any feature areas — the repo appears to have no tracked source files yet.",
      'Add some code, commit it, then try Bootstrap again. Or create qa/coverage-map.md by hand.',
    );
  }

  try {
    mkdirSync(mapDir, { recursive: true });
  } catch {
    // mkdir may race; let writeFile surface a clean error below.
  }

  try {
    writeFileSync(mapPath, renderCoverageMap(finalProposals), 'utf8');
  } catch (e) {
    throw new ObeliskError(
      'IO',
      `Could not write qa/coverage-map.md: ${(e as Error).message}`,
      'Make sure the repo is writable and the qa/ directory can be created.',
    );
  }
  return { proposals: finalProposals, written: true };
}

function renderCoverageMap(
  proposals: { label: string; globs: string[]; filesMatched: number }[],
): string {
  const lines: string[] = [];
  lines.push('# Coverage map');
  lines.push('');
  lines.push('<!-- Each entry maps a label to one or more file globs. Tag your test');
  lines.push('     cases with a label (e.g. `scope: [auth]`) and they will count toward');
  lines.push('     that feature on the Coverage screen.');
  lines.push('');
  lines.push('     Edit this file directly to refine the globs. -->');
  lines.push('');
  for (const p of proposals) {
    lines.push(`- \`${p.label}\`: ${p.globs.map((g) => `\`${g}\``).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function handleCoverageGenerateMap(
  payload: IpcMap['coverage:generateMap']['req'],
): Promise<IpcMap['coverage:generateMap']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const jobId = startMapGenerationJob({
    repo,
    ...(payload.runnerOverride ? { runnerOverride: payload.runnerOverride } : {}),
    ...(payload.modelOverride !== undefined ? { modelOverride: payload.modelOverride } : {}),
  });
  return { jobId };
}

export async function handleCoverageGenerationJobs(
  payload: IpcMap['coverage:generationJobs']['req'],
): Promise<IpcMap['coverage:generationJobs']['res']> {
  return listJobs(payload.repoId);
}

export async function handleCoverageDismissJob(
  payload: IpcMap['coverage:dismissJob']['req'],
): Promise<IpcMap['coverage:dismissJob']['res']> {
  dismissJob(payload.jobId);
  return { ok: true };
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
