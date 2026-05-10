-- A finding's identity is defined by its content, not its title. The agent
-- often rewords the same bug across runs ("Capstone node opens story player"
-- vs "Story player launches when capstone is clicked"); title-similarity
-- catches a lot but not all of these, so a user who clicked "Not a bug"
-- can still see the same finding re-emerge later.
--
-- Store a content fingerprint (sha256 of normalized title + expected +
-- actual + suspected_files) on the preview row. QA agents check this set
-- on every run and hard-drop any finding whose fingerprint matches a
-- prior preview — open, dismissed, or published — before falling through
-- to the existing title-similarity check.
--
-- Pre-existing rows keep fingerprint = NULL and continue to dedup via
-- title-similarity only (graceful degradation; no backfill needed).

ALTER TABLE previews ADD COLUMN fingerprint TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_previews_repo_fingerprint
  ON previews(repo_id, fingerprint);
