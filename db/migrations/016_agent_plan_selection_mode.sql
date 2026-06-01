-- How a QA agent picks its test plan. NULL/absent ⇒ 'fixed' (legacy
-- behavior: use default_plan_id). 'least-covered' ⇒ on every run, target the
-- feature with the lowest coverage, generating the coverage map and/or a test
-- plan for it first when none exists. Dispatch re-resolves at run time, so the
-- value is just a mode flag — no FK / backfill needed.
ALTER TABLE agents ADD COLUMN plan_selection_mode TEXT;
