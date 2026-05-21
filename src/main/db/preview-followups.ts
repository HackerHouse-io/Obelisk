import { getDb } from '.';
import { updatePreviewPayload, type IssuePlan } from './previews';
import type { PreviewFollowup, PreviewFollowupRole } from '../../shared/types';

/**
 * Transcript rows for the FileIssueModal follow-up chat. See migration
 * 012_preview_followups.sql for the rationale. The `system` role is an
 * internal snapshot of the original `previews.payload` taken once on the
 * first refine — it is never surfaced to the renderer.
 */

interface Row {
  id: number;
  preview_id: number;
  role: PreviewFollowupRole;
  content: string;
  created_at: string;
}

function rowToFollowup(row: Row): PreviewFollowup {
  return {
    id: row.id,
    previewId: row.preview_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * Visible transcript (user + assistant) in chronological order. The
 * internal `system` snapshot row is excluded.
 *
 * Pass `limit` to fetch only the most recent N rows (still returned in
 * chronological order). The refine handler uses this to bound the prompt
 * size and the token cost of long conversations.
 */
export function listPreviewFollowups(
  previewId: number,
  opts: { limit?: number } = {},
): PreviewFollowup[] {
  const db = getDb();
  if (opts.limit !== undefined) {
    const rows = db
      .prepare<[number, number], Row>(
        `SELECT id, preview_id, role, content, created_at
           FROM preview_followups
           WHERE preview_id = ? AND role IN ('user','assistant')
           ORDER BY id DESC
           LIMIT ?`,
      )
      .all(previewId, opts.limit);
    return rows.reverse().map(rowToFollowup);
  }
  const rows = db
    .prepare<[number], Row>(
      `SELECT id, preview_id, role, content, created_at
         FROM preview_followups
         WHERE preview_id = ? AND role IN ('user','assistant')
         ORDER BY id ASC`,
    )
    .all(previewId);
  return rows.map(rowToFollowup);
}

export function appendPreviewFollowup(opts: {
  previewId: number;
  role: PreviewFollowupRole;
  content: string;
}): PreviewFollowup {
  const at = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO preview_followups (preview_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
    )
    .run(opts.previewId, opts.role, opts.content, at);
  return {
    id: Number(result.lastInsertRowid),
    previewId: opts.previewId,
    role: opts.role,
    content: opts.content,
    createdAt: at,
  };
}

/**
 * Inserts a `role='system'` row holding the original `previews.payload`
 * JSON exactly once per preview. The unique partial index on (preview_id)
 * WHERE role='system' (migration 012) backs the OR IGNORE clause, so
 * concurrent first-refine attempts can't double-snapshot.
 */
export function snapshotOriginalIfMissing(opts: { previewId: number; payloadJson: string }): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO preview_followups (preview_id, role, content, created_at)
         VALUES (?, 'system', ?, ?)`,
    )
    .run(opts.previewId, opts.payloadJson, new Date().toISOString());
}

/**
 * Read the snapshot row (the original payload JSON) for a preview, or
 * null if no refine has happened yet.
 */
export function getOriginalSnapshot(previewId: number): { payloadJson: string } | null {
  const row = getDb()
    .prepare<[number], { content: string }>(
      `SELECT content FROM preview_followups
        WHERE preview_id = ? AND role = 'system'
        LIMIT 1`,
    )
    .get(previewId);
  if (!row) return null;
  return { payloadJson: row.content };
}

/**
 * Drop every transcript row (visible + snapshot). Used by "Revert to
 * original" after the original payload has been restored to the preview row.
 */
export function clearPreviewFollowups(previewId: number): void {
  getDb().prepare(`DELETE FROM preview_followups WHERE preview_id = ?`).run(previewId);
}

/**
 * Restore a preview's payload + fingerprint and wipe its transcript in
 * one transaction, so a crash mid-revert can't leave the row reverted but
 * the transcript still populated (or vice versa).
 */
export function revertPreviewToOriginal(opts: {
  previewId: number;
  payload: IssuePlan;
  fingerprint: string | null;
}): void {
  const db = getDb();
  const tx = db.transaction(() => {
    updatePreviewPayload({
      previewId: opts.previewId,
      payload: opts.payload,
      fingerprint: opts.fingerprint,
    });
    db.prepare(`DELETE FROM preview_followups WHERE preview_id = ?`).run(opts.previewId);
  });
  tx();
}
