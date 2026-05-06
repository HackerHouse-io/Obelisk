import { basename } from 'node:path';
import { getDb } from '.';
import type {
  AgentName,
  FindingSeverity,
  PreviewedFinding,
  PreviewEvidence,
} from '../../shared/types';

/**
 * audit_log rows we treat specially:
 *   kind='preview'            — agent's PublishPlan (the would-be issue)
 *   kind='preview_published'  — user manually filed it; payload links to source
 *   kind='preview_dismissed'  — user marked it false-positive
 */
const SUPPORTED_EVIDENCE_KINDS = new Set([
  'screenshot',
  'recording',
  'trace',
  'syslog',
  'log',
  'curl_log',
]);

const SEVERITY_LABEL_PATTERN = /^severity:(P[012])$/;

interface PreviewRow {
  id: number;
  run_id: string;
  agent_name: AgentName;
  repo_id: string;
  at: string;
  payload: string;
}

interface IssuePlan {
  kind: 'issue';
  title: string;
  body: string;
  labels?: string[];
}

function isIssuePlan(v: unknown): v is IssuePlan {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o['kind'] === 'issue' &&
    typeof o['title'] === 'string' &&
    typeof o['body'] === 'string' &&
    (o['labels'] === undefined ||
      (Array.isArray(o['labels']) && o['labels'].every((s) => typeof s === 'string')))
  );
}

function severityFromLabels(labels: string[]): FindingSeverity | null {
  for (const l of labels) {
    const m = SEVERITY_LABEL_PATTERN.exec(l);
    if (m) return m[1] as FindingSeverity;
  }
  return null;
}

interface PublishedMarker {
  issueNumber: number;
  htmlUrl: string;
  at: string;
}

function loadEvidenceMap(runIds: string[]): Map<string, PreviewEvidence[]> {
  const map = new Map<string, PreviewEvidence[]>();
  if (runIds.length === 0) return map;
  const placeholders = runIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<string[], { run_id: string; id: string; kind: string; path: string; bytes: number }>(
      `SELECT run_id, id, kind, path, bytes
       FROM evidence_artifacts
       WHERE run_id IN (${placeholders})
       ORDER BY id ASC`,
    )
    .all(...runIds);
  for (const r of rows) {
    if (!SUPPORTED_EVIDENCE_KINDS.has(r.kind)) continue;
    const list = map.get(r.run_id) ?? [];
    list.push({ id: r.id, kind: r.kind, basename: basename(r.path), bytes: r.bytes });
    map.set(r.run_id, list);
  }
  return map;
}

function loadAuditMarkerMap<T>(
  kind: string,
  parse: (payload: string, at: string) => T | null,
): Map<number, T> {
  const map = new Map<number, T>();
  const rows = getDb()
    .prepare<[string], { src: number | null; payload: string; at: string }>(
      `SELECT json_extract(payload,'$.sourcePreviewId') AS src, payload, at
       FROM audit_log
       WHERE kind = ?
       ORDER BY id ASC`,
    )
    .all(kind);
  for (const r of rows) {
    if (typeof r.src !== 'number') continue;
    const v = parse(r.payload, r.at);
    if (v !== null) map.set(r.src, v);
  }
  return map;
}

function parsePublished(payload: string, at: string): PublishedMarker | null {
  try {
    const p = JSON.parse(payload) as { issueNumber?: unknown; htmlUrl?: unknown };
    if (typeof p.issueNumber !== 'number' || typeof p.htmlUrl !== 'string') return null;
    return { issueNumber: p.issueNumber, htmlUrl: p.htmlUrl, at };
  } catch {
    return null;
  }
}

interface RowEnrichment {
  evidenceByRun: Map<string, PreviewEvidence[]>;
  publishedById: Map<number, PublishedMarker>;
  dismissedIds: Set<number>;
}

function rowToFinding(row: PreviewRow, enrich: RowEnrichment): PreviewedFinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!isIssuePlan(parsed)) return null;
  const labels = parsed.labels ?? [];
  return {
    id: row.id,
    runId: row.run_id,
    agentName: row.agent_name,
    at: row.at,
    title: parsed.title,
    body: parsed.body,
    labels,
    severity: severityFromLabels(labels),
    evidence: enrich.evidenceByRun.get(row.run_id) ?? [],
    published: enrich.publishedById.get(row.id) ?? null,
    dismissed: enrich.dismissedIds.has(row.id),
  };
}

/**
 * Pull recent Observe-mode previews for a repo, newest first. The join
 * filters audit rows down to the runs that belong to `repoId`.
 */
export function listPreviewsForRepo(repoId: string, limit = 25): PreviewedFinding[] {
  const rows = getDb()
    .prepare<[string, number], PreviewRow>(
      `SELECT a.id, a.run_id, r.agent_name, r.repo_id, a.at, a.payload
       FROM audit_log a
       JOIN runs r ON r.id = a.run_id
       WHERE r.repo_id = ? AND a.kind = 'preview'
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .all(repoId, limit);

  const enrich = enrichmentFor(rows);
  const out: PreviewedFinding[] = [];
  for (const row of rows) {
    const f = rowToFinding(row, enrich);
    if (f) out.push(f);
  }
  return out;
}

function enrichmentFor(rows: PreviewRow[]): RowEnrichment {
  const runIds = Array.from(new Set(rows.map((r) => r.run_id)));
  const dismissedMap = loadAuditMarkerMap<true>('preview_dismissed', () => true);
  return {
    evidenceByRun: loadEvidenceMap(runIds),
    publishedById: loadAuditMarkerMap('preview_published', parsePublished),
    dismissedIds: new Set(dismissedMap.keys()),
  };
}

export interface PreviewLookup {
  finding: PreviewedFinding;
  repoId: string;
}

export function getPreviewById(previewId: number): PreviewLookup | null {
  const row = getDb()
    .prepare<[number], PreviewRow>(
      `SELECT a.id, a.run_id, r.agent_name, r.repo_id, a.at, a.payload
       FROM audit_log a
       JOIN runs r ON r.id = a.run_id
       WHERE a.id = ? AND a.kind = 'preview'`,
    )
    .get(previewId);
  if (!row) return null;
  const finding = rowToFinding(row, enrichmentFor([row]));
  if (!finding) return null;
  return { finding, repoId: row.repo_id };
}

export function markPreviewPublished(opts: {
  sourcePreviewId: number;
  runId: string;
  issueNumber: number;
  htmlUrl: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (run_id, at, kind, payload)
       VALUES (?, ?, 'preview_published', ?)`,
    )
    .run(
      opts.runId,
      new Date().toISOString(),
      JSON.stringify({
        sourcePreviewId: opts.sourcePreviewId,
        issueNumber: opts.issueNumber,
        htmlUrl: opts.htmlUrl,
      }),
    );
}

export function markPreviewDismissed(opts: { sourcePreviewId: number; runId: string }): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (run_id, at, kind, payload)
       VALUES (?, ?, 'preview_dismissed', ?)`,
    )
    .run(
      opts.runId,
      new Date().toISOString(),
      JSON.stringify({ sourcePreviewId: opts.sourcePreviewId }),
    );
}
