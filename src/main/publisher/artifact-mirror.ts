import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listArtifacts, markArtifactUploaded } from '../db/evidence';

/**
 * Mirror evidence artifacts referenced from a PR body into the repo at
 * `.obelisk/records/prs/<pr-number>/<artifact-id>-<filename>`.
 *
 * Only the artifacts that actually appear in the PR body get mirrored — the
 * rest stay local (TECH_DESIGN.md §9.3). For Phase 4 we mirror everything
 * the run produced; future phases will be selective once PR-body link
 * resolution is plumbed.
 */
export interface MirrorInput {
  worktreePath: string;
  runId: string;
  prNumber: number;
}

export interface MirrorResult {
  /** Repo-relative paths that were copied into .obelisk/records/. */
  mirroredPaths: string[];
}

export function mirrorEvidenceToRepo(input: MirrorInput): MirrorResult {
  const targetDir = join(input.worktreePath, '.obelisk', 'records', 'prs', String(input.prNumber));
  mkdirSync(targetDir, { recursive: true });

  const mirrored: string[] = [];
  for (const a of listArtifacts(input.runId)) {
    if (!existsSync(a.path)) continue;
    const filename = `${a.id}-${basename(a.path)}`;
    const dest = join(targetDir, filename);
    copyFileSync(a.path, dest);
    markArtifactUploaded(a.id);
    mirrored.push(`.obelisk/records/prs/${input.prNumber}/${filename}`);
  }
  return { mirroredPaths: mirrored };
}
