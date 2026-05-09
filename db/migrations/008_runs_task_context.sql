-- Phase 1.6: surface the claimed task at run start.
--
-- Mission Control + the run-started toast want to render the issue title
-- (and other agents' equivalent context strings) the moment a run begins.
-- Pulling that from the backlog table at render time is racy — by the time
-- the renderer asks, the row may already be unlocked, deleted, or
-- repurposed for another run. Snapshotting the context onto the run row
-- closes that gap and stays correct after the source row is reaped.

ALTER TABLE runs ADD COLUMN task_context TEXT;
