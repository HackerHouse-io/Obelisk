-- Per-preview chat transcript that lets the user refine a QA-Hunter draft
-- finding before opening it as a GitHub issue. The agent often misreads the
-- spec vs the code (e.g. labels the code wrong when the spec is what needs
-- updating); a few turns of back-and-forth let the user reframe the issue
-- so the filed copy is actually correct.
--
-- Each row is one message. `role='system'` is an internal one-shot snapshot
-- of the original `previews.payload` (taken on the first refine) so "Revert
-- to original" can restore it; system rows are never surfaced in the UI.
-- Visible turns are `user` / `assistant`.
--
-- The transcript is purely additive; the live finding state is the
-- `previews.payload` row itself (which the refine handler overwrites each
-- turn). This keeps every reader of previews — list, dedup, publish — on
-- a single source of truth without overlay logic.

CREATE TABLE IF NOT EXISTS preview_followups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id  INTEGER NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_followups_preview
  ON preview_followups(preview_id, id);
-- Partial uniqueness: at most one `system` snapshot per preview. Lets the
-- refine handler use INSERT OR IGNORE instead of SELECT-then-INSERT,
-- which is race-safe under concurrent first-refine attempts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_followups_system_unique
  ON preview_followups(preview_id) WHERE role = 'system';
