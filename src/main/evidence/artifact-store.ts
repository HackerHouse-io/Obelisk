import { app } from 'electron';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { recordArtifact, type EvidenceKind } from '../db/evidence';

/**
 * Local artifact storage at <userData>/Obelisk/records/<repoId>/<runId>/<kind>/<filename>.
 * The publisher mirrors a subset to .obelisk/records/ inside the repo.
 *
 * Test/dev fallback when Electron's `app` is not available: store under
 * <cwd>/.obelisk-records/.
 */

function recordsRoot(): string {
  try {
    return join(app.getPath('userData'), 'records');
  } catch {
    return join(process.cwd(), '.obelisk-records');
  }
}

export interface SaveArtifactInput {
  runId: string;
  repoId: string;
  kind: EvidenceKind;
  filename: string;
  contents: Buffer | string;
}

export interface SavedArtifact {
  id: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
}

export function saveArtifact(input: SaveArtifactInput): SavedArtifact {
  const dir = join(recordsRoot(), input.repoId, input.runId, input.kind);
  mkdirSync(dir, { recursive: true });
  const absolutePath = join(dir, input.filename);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.contents);
  const bytes = statSync(absolutePath).size;
  const sha256 = createHash('sha256').update(input.contents).digest('hex');

  const artifact = recordArtifact({
    runId: input.runId,
    kind: input.kind,
    path: absolutePath,
    bytes,
    sha256,
  });

  return { id: artifact.id, absolutePath, bytes, sha256 };
}
