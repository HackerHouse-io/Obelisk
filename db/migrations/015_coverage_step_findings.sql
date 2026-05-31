-- Per-step linkage to the spawned run + findings count, so the Coverage Agent
-- card can show "found N issues" for each hunt and deep-link into Mission
-- Control. run_id is the qa-hunter run id captured via the orchestrator's
-- onStarted callback; findings is the count of previews that run produced
-- (COUNT over previews.run_id), recorded after the hunt completes. Both are
-- NULL for map/generate steps and for older rows.

ALTER TABLE coverage_run_steps ADD COLUMN run_id TEXT;
ALTER TABLE coverage_run_steps ADD COLUMN findings INTEGER;
