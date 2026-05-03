import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { recordArtifact, type EvidenceKind } from '../../db/evidence';
import { sha256Buffer } from '../../prompt-compiler/hash';

/**
 * Read an agent-produced artifact from the worktree (relative or absolute
 * path) and register it in `evidence_artifacts`. Returns the artifact id
 * so callers can reference it from issue/PR bodies via obelisk:// URIs;
 * returns null when the path is empty or the file can't be read.
 *
 * Single read: bytes + sha are derived from the same buffer (no TOCTOU).
 */
export function registerArtifactFromPath(opts: {
  rel: string | undefined;
  repoPath: string;
  runId: string;
  kind: EvidenceKind;
}): string | null {
  if (!opts.rel) return null;
  const abs = isAbsolute(opts.rel) ? opts.rel : join(opts.repoPath, opts.rel);
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  const recorded = recordArtifact({
    runId: opts.runId,
    kind: opts.kind,
    path: abs,
    bytes: buf.byteLength,
    sha256: sha256Buffer(buf),
  });
  return recorded.id;
}
