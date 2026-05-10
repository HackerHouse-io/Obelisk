import { basename } from 'node:path';
import { getDb } from '.';
import type {
  AgentName,
  FindingSeverity,
  PreviewedFinding,
  PreviewEvidence,
} from '../../shared/types';

/**
 * Previews live in their own table now (`previews`) — see migration
 * `005_previews_table.sql`. The previous design stored them as audit_log
 * rows joined by run_id, which meant deleting a run cascaded the previews
 * away (the run is scratch; the finding is the durable artifact and must
 * outlive its source run).
 *
 * `preview_markers` carries the published / dismissed lifecycle events.
 *
 * The exported helpers here keep the same signatures so qa-hunter,
 * manual-qa, the orchestrator, the IPC layer, and the coverage aggregator
 * don't need to change.
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
  run_id: string | null;
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
  fingerprint?: string;
}

function isIssuePlan(v: unknown): v is IssuePlan {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o['kind'] === 'issue' &&
    typeof o['title'] === 'string' &&
    typeof o['body'] === 'string' &&
    (o['labels'] === undefined ||
      (Array.isArray(o['labels']) && o['labels'].every((s) => typeof s === 'string'))) &&
    (o['fingerprint'] === undefined || typeof o['fingerprint'] === 'string')
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

interface MarkerRow {
  preview_id: number;
  kind: 'published' | 'dismissed';
  at: string;
  payload: string | null;
}

function loadMarkers(): {
  published: Map<number, PublishedMarker>;
  dismissed: Set<number>;
} {
  const rows = getDb()
    .prepare<[], MarkerRow>(
      `SELECT preview_id, kind, at, payload
         FROM preview_markers
         ORDER BY id ASC`,
    )
    .all();
  const published = new Map<number, PublishedMarker>();
  const dismissed = new Set<number>();
  for (const r of rows) {
    if (r.kind === 'dismissed') {
      dismissed.add(r.preview_id);
      continue;
    }
    if (r.kind === 'published') {
      const parsed = parsePublishedPayload(r.payload, r.at);
      if (parsed) published.set(r.preview_id, parsed);
    }
  }
  return { published, dismissed };
}

function parsePublishedPayload(payload: string | null, at: string): PublishedMarker | null {
  if (!payload) return null;
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
    // Run id may be null if the originating run was deleted — the finding
    // survives. Renderer treats null as "originating run was cleaned up".
    runId: row.run_id ?? '',
    agentName: row.agent_name,
    at: row.at,
    title: parsed.title,
    body: parsed.body,
    labels,
    severity: severityFromLabels(labels),
    evidence: row.run_id ? (enrich.evidenceByRun.get(row.run_id) ?? []) : [],
    published: enrich.publishedById.get(row.id) ?? null,
    dismissed: enrich.dismissedIds.has(row.id),
  };
}

/**
 * Titles of previews that are still "open" — neither published as a GitHub
 * issue nor dismissed by the user. Agents call this on each run to suppress
 * findings whose title fuzzy-matches an existing open preview, so a recurring
 * sweep doesn't pile three copies of the same bug into the previews list.
 */
export function listOpenPreviewTitlesForRepo(repoId: string): string[] {
  return listPreviewTitlesForRepo(repoId, { scope: 'open' });
}

/**
 * Titles of every recent preview — open, dismissed, AND published. Used
 * for dedup: a finding whose title fuzzy-matches a dismissed preview ("not
 * a bug") shouldn't get re-filed as a fresh preview the next sweep, and a
 * published preview is already a real GitHub issue we don't want a clone
 * of. Returns at most 200 titles, newest first.
 */
export function listAllPreviewTitlesForRepo(repoId: string): string[] {
  return listPreviewTitlesForRepo(repoId, { scope: 'all' });
}

function listPreviewTitlesForRepo(repoId: string, opts: { scope: 'open' | 'all' }): string[] {
  const previews = listPreviewsForRepo(repoId, 200);
  const filtered =
    opts.scope === 'open' ? previews.filter((p) => !p.dismissed && !p.published) : previews;
  return filtered
    .map((p) => p.title)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

/**
 * Pull recent Observe-mode previews for a repo, newest first.
 */
export function listPreviewsForRepo(repoId: string, limit = 25): PreviewedFinding[] {
  const rows = getDb()
    .prepare<[string, number], PreviewRow>(
      `SELECT id, run_id, agent_name, repo_id, at, payload
         FROM previews
         WHERE repo_id = ?
         ORDER BY id DESC
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
  const runIds = Array.from(new Set(rows.map((r) => r.run_id).filter((id): id is string => !!id)));
  const markers = loadMarkers();
  return {
    evidenceByRun: loadEvidenceMap(runIds),
    publishedById: markers.published,
    dismissedIds: markers.dismissed,
  };
}

export interface PreviewLookup {
  finding: PreviewedFinding;
  repoId: string;
}

export function getPreviewById(previewId: number): PreviewLookup | null {
  const row = getDb()
    .prepare<[number], PreviewRow>(
      `SELECT id, run_id, agent_name, repo_id, at, payload
         FROM previews
         WHERE id = ?`,
    )
    .get(previewId);
  if (!row) return null;
  const finding = rowToFinding(row, enrichmentFor([row]));
  if (!finding) return null;
  return { finding, repoId: row.repo_id };
}

/**
 * Insert a new preview. Called by the orchestrator when the agent emits a
 * PublishPlan that should land in front of the user instead of being
 * filed directly. `fingerprint` is the optional sha256 content key
 * computed by the agent and indexed for dedup queries (migration 010).
 * Returns the new preview's id.
 */
export function insertPreview(opts: {
  repoId: string;
  runId: string;
  agentName: AgentName;
  payload: unknown;
  fingerprint?: string | null;
}): number {
  const at = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO previews (repo_id, run_id, agent_name, at, payload, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.repoId,
      opts.runId,
      opts.agentName,
      at,
      JSON.stringify(opts.payload),
      opts.fingerprint ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * All non-null fingerprints recorded against this repo's previews — open,
 * dismissed, AND published. QA agents call this on each run and hard-drop
 * any new finding whose fingerprint is in this set, before the title-
 * similarity check runs. Survives agent rewording across runs because the
 * fingerprint hashes the full content tuple, not just the title.
 */
export function listKnownFingerprintsForRepo(repoId: string): Set<string> {
  const rows = getDb()
    .prepare<[string], { fingerprint: string }>(
      `SELECT fingerprint
         FROM previews
         WHERE repo_id = ? AND fingerprint IS NOT NULL`,
    )
    .all(repoId);
  return new Set(rows.map((r) => r.fingerprint));
}

export function markPreviewPublished(opts: {
  sourcePreviewId: number;
  runId: string;
  issueNumber: number;
  htmlUrl: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO preview_markers (preview_id, kind, at, payload)
         VALUES (?, 'published', ?, ?)
         ON CONFLICT(preview_id, kind) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
    )
    .run(
      opts.sourcePreviewId,
      new Date().toISOString(),
      JSON.stringify({ issueNumber: opts.issueNumber, htmlUrl: opts.htmlUrl }),
    );
}

export function markPreviewDismissed(opts: { sourcePreviewId: number; runId: string }): void {
  void opts.runId; // legacy parameter — markers are now keyed by preview, not run
  getDb()
    .prepare(
      `INSERT INTO preview_markers (preview_id, kind, at)
         VALUES (?, 'dismissed', ?)
         ON CONFLICT(preview_id, kind) DO UPDATE SET at = excluded.at`,
    )
    .run(opts.sourcePreviewId, new Date().toISOString());
}

/**
 * Reverse `markPreviewDismissed`: remove the dismissed marker so the
 * finding reappears in the FindingsTab. Used by the 5-second undo toast
 * and the persistent "Show dismissed → Undismiss" affordance. Note: the
 * fingerprint stays on the preview row, so until the user undismisses,
 * future runs will keep suppressing the same finding (which is the
 * intended behaviour). After undismiss, the fingerprint *still* matches
 * (the row is no longer dismissed but is still recorded), so future
 * runs continue to dedup against it — undismiss surfaces the existing
 * preview rather than letting a new copy land.
 */
export function removePreviewDismissedMarker(previewId: number): void {
  getDb()
    .prepare(`DELETE FROM preview_markers WHERE preview_id = ? AND kind = 'dismissed'`)
    .run(previewId);
}
