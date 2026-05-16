-- Soft-delete archive for runs.
--
-- Mission Control's "Clear completed" used to hard-delete done/failed runs
-- (and cascade their audit_log + evidence). That made it impossible to
-- look up old work or recover evidence after dismissal. Adding archived_at
-- turns "Clear completed" into a soft move; permanent delete is still
-- available from the Archive view (which routes through the existing
-- deleteRun() path, so cascades + on-disk cleanup remain unchanged).

ALTER TABLE runs ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_repo_archived ON runs(repo_id, archived_at);
