import { listRuns, getRun } from '../db/runs';
import { listArtifacts } from '../db/evidence';
import { ObeliskError } from '../../shared/errors';
import { getDb } from '../db';
import type { IpcMap, AuditLine } from '../../shared/types';

export async function handleRunsList(
  payload: IpcMap['runs:list']['req'],
): Promise<IpcMap['runs:list']['res']> {
  return listRuns(payload.repoId, payload.limit ?? 50);
}

export async function handleRunsGet(
  payload: IpcMap['runs:get']['req'],
): Promise<IpcMap['runs:get']['res']> {
  const run = getRun(payload.runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${payload.runId} not found`);
  const auditRows = getDb()
    .prepare<
      [string],
      { id: number; run_id: string; at: string; kind: string; payload: string }
    >('SELECT * FROM audit_log WHERE run_id = ? ORDER BY id ASC')
    .all(payload.runId);
  const auditLog: AuditLine[] = auditRows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    at: r.at,
    kind: r.kind,
    payload: safeParse(r.payload),
  }));
  const evidence = listArtifacts(payload.runId).map((a) => ({
    kind: a.kind,
    path: a.path,
    bytes: a.bytes,
    sha256: a.sha256,
  }));
  return { ...run, auditLog, evidence };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
