import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { IpcMap } from '../../shared/types';
import { ObeliskError } from '../../shared/errors';
import { buildCoverageReport } from '../coverage/aggregate';
import { parseCoverageMap } from '../coverage/coverage-map';
import { scanFromTrackedFiles } from '../coverage/feature-scan';
import { getRepo } from '../db/repos';

export async function handleCoverageList(
  payload: IpcMap['coverage:list']['req'],
): Promise<IpcMap['coverage:list']['res']> {
  return buildCoverageReport(payload.repoId);
}

/**
 * Bootstrap `qa/coverage-map.md` from a heuristic + filesystem scan.
 *
 *   - `commit: false / omitted` → returns proposed entries for preview only
 *   - `commit: true`            → writes `qa/coverage-map.md` directly
 *
 * Refuses to overwrite a user-edited map that parses to ≥1 label. A stale
 * file that parses to 0 labels is treated as absent and replaced.
 */
export async function handleCoverageBootstrapMap(
  payload: IpcMap['coverage:bootstrapMap']['req'],
): Promise<IpcMap['coverage:bootstrapMap']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);

  const trackedFiles = await listTrackedFiles(repo.localPath);
  const proposals = scanFromTrackedFiles(repo.localPath, trackedFiles);

  if (!payload.commit) {
    return { proposals, written: false };
  }

  if (proposals.length === 0) {
    throw new ObeliskError(
      'INVALID_INPUT',
      "Couldn't detect any feature areas — the repo appears to have no tracked source files yet.",
      'Add some code, commit it, then try Bootstrap again. Or create qa/coverage-map.md by hand.',
    );
  }

  const mapDir = join(repo.localPath, 'qa');
  const mapPath = join(mapDir, 'coverage-map.md');
  if (existsSync(mapPath)) {
    let usable = false;
    try {
      usable = parseCoverageMap(readFileSync(mapPath, 'utf8')).size > 0;
    } catch {
      usable = false;
    }
    if (usable) {
      return {
        proposals,
        written: false,
        reason: 'coverage-map.md already exists — edit it directly to refine globs.',
      };
    }
  }
  try {
    mkdirSync(mapDir, { recursive: true });
  } catch {
    // mkdir may race; let writeFile surface a clean error below.
  }

  try {
    writeFileSync(mapPath, renderCoverageMap(proposals), 'utf8');
  } catch (e) {
    throw new ObeliskError(
      'IO',
      `Could not write qa/coverage-map.md: ${(e as Error).message}`,
      'Make sure the repo is writable and the qa/ directory can be created.',
    );
  }
  return { proposals, written: true };
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
