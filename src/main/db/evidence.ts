import { ulid } from 'ulid';
import { getDb } from './index';

export type EvidenceKind =
  | 'patch'
  | 'test_output'
  | 'screenshot'
  | 'trace'
  | 'log'
  | 'reasoning'
  | 'failing_test_diff'
  | 'curl_log';

export interface EvidenceArtifact {
  id: string;
  runId: string;
  kind: EvidenceKind;
  path: string;
  bytes: number;
  sha256: string;
  uploadedToRepo: boolean;
}

interface Row {
  id: string;
  run_id: string;
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
  uploaded_to_repo: number;
}

function mapRow(r: Row): EvidenceArtifact {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as EvidenceKind,
    path: r.path,
    bytes: r.bytes,
    sha256: r.sha256,
    uploadedToRepo: r.uploaded_to_repo === 1,
  };
}

export interface CreateArtifactInput {
  runId: string;
  kind: EvidenceKind;
  path: string;
  bytes: number;
  sha256: string;
}

export function recordArtifact(input: CreateArtifactInput): EvidenceArtifact {
  const id = ulid();
  getDb()
    .prepare(
      `INSERT INTO evidence_artifacts (id, run_id, kind, path, bytes, sha256, uploaded_to_repo)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(id, input.runId, input.kind, input.path, input.bytes, input.sha256);
  const row = getDb()
    .prepare<[string], Row>('SELECT * FROM evidence_artifacts WHERE id = ?')
    .get(id);
  if (!row) throw new Error('recordArtifact: row vanished');
  return mapRow(row);
}

export function listArtifacts(runId: string): EvidenceArtifact[] {
  return getDb()
    .prepare<[string], Row>('SELECT * FROM evidence_artifacts WHERE run_id = ? ORDER BY id ASC')
    .all(runId)
    .map(mapRow);
}

export function markArtifactUploaded(id: string): void {
  getDb().prepare('UPDATE evidence_artifacts SET uploaded_to_repo = 1 WHERE id = ?').run(id);
}
