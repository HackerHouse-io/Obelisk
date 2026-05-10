-- Index for PR Reviewer's livelock-cap query in selectTask:
--   SELECT COUNT(*) FROM runs
--   WHERE repo_id = ? AND agent_name = 'pr-reviewer'
--     AND task_ref LIKE 'pr#<n>@%' AND state = 'done'
--
-- Without this index the query falls back to the broader
-- (repo_id, agent_name, started_at) index from 001_initial and filters
-- by LIKE in memory — fine on small repos but O(N) on the runs table
-- once history accumulates. The partial WHERE bounds cardinality so the
-- index stays small (only completed pr-reviewer rows live in it).

CREATE INDEX IF NOT EXISTS idx_runs_pr_reviewer_livelock
  ON runs(repo_id, task_ref)
  WHERE agent_name = 'pr-reviewer' AND state = 'done';
