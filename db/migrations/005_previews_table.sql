-- Previews used to live in audit_log rows with kind='preview', joined to
-- runs by run_id. That meant deleting a run cascaded the audit rows away
-- and silently destroyed the user's findings (the run was scratch — the
-- finding is the durable artifact and shouldn't share its lifetime).
--
-- Move previews into their own table with ON DELETE SET NULL on the run
-- FK, so deleting/clearing runs preserves the findings (just nulls the
-- back-pointer to the originating run).

CREATE TABLE IF NOT EXISTS previews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  run_id          TEXT NULL REFERENCES runs(id) ON DELETE SET NULL,
  agent_name      TEXT NOT NULL,
  at              TEXT NOT NULL,
  payload         TEXT NOT NULL,
  -- audit_log.id of the row this preview was migrated from. Used to wire
  -- up published/dismissed markers during the backfill below; NULL for
  -- net-new previews written via the new code path.
  source_audit_id INTEGER NULL
);
CREATE INDEX IF NOT EXISTS idx_previews_repo ON previews(repo_id);
CREATE INDEX IF NOT EXISTS idx_previews_run ON previews(run_id);
CREATE INDEX IF NOT EXISTS idx_previews_source_audit ON previews(source_audit_id);

-- Markers (published / dismissed). Cascade with the preview, but the
-- preview itself outlives any run.
CREATE TABLE IF NOT EXISTS preview_markers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id  INTEGER NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('published','dismissed')),
  at          TEXT NOT NULL,
  payload     TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_markers_preview ON preview_markers(preview_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_markers_kind ON preview_markers(preview_id, kind);

-- Backfill any audit_log rows we still have. Old rows are LEFT in place
-- (cheap, harmless) so a downgrade is possible — new code only reads from
-- the new tables.
INSERT INTO previews (repo_id, run_id, agent_name, at, payload, source_audit_id)
SELECT r.repo_id, a.run_id, r.agent_name, a.at, a.payload, a.id
  FROM audit_log a
  JOIN runs r ON r.id = a.run_id
 WHERE a.kind = 'preview';

-- Match published/dismissed markers to their previews via the source_audit_id
-- linkage that previews.ts uses today (json_extract($.sourcePreviewId)).
INSERT INTO preview_markers (preview_id, kind, at, payload)
SELECT p.id, 'published', a.at, a.payload
  FROM audit_log a
  JOIN previews p ON p.source_audit_id = json_extract(a.payload, '$.sourcePreviewId')
 WHERE a.kind = 'preview_published';

INSERT INTO preview_markers (preview_id, kind, at, payload)
SELECT p.id, 'dismissed', a.at, a.payload
  FROM audit_log a
  JOIN previews p ON p.source_audit_id = json_extract(a.payload, '$.sourcePreviewId')
 WHERE a.kind = 'preview_dismissed';
