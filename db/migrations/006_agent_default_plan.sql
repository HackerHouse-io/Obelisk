-- Per-agent default test plan. When set, "Run now" and scheduled
-- dispatches use this plan id without prompting for plan selection.
-- ON DELETE we don't bother with FKs (plans live in the user's repo
-- on disk, not in the DB) — `agents:run` re-resolves the id at run
-- time, so a stale id just falls through to single-plan resolution.
ALTER TABLE agents ADD COLUMN default_plan_id TEXT;
