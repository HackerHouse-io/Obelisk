-- Multi-instance agents + Phase 2 detail-pane columns + race-proof claim tables.
-- Source of truth: plans/stateful-twirling-tide.md
--
-- Changes:
--   * Drop agents UNIQUE(repo_id, name) so multiple instances of the same type can coexist.
--   * Add display_name, created_at to agents.
--   * Add Phase 2 columns: perm_*, model_override, schedule_json.
--   * Add runs.agent_id so stats / history can be scoped per instance.
--   * Add pr_review_claims for atomic per-PR claiming by PR Reviewer instances.
--
-- Manual QA + QA Hunter remain singletons (registry flag, not schema-enforced) — both
-- sweep the whole repo and adding a 2nd instance would do duplicate work. iOS QA Pilot
-- gets per-flow concurrency for free via the existing qa_ios_flows.claimed_run_id index.

PRAGMA foreign_keys = ON;

-- 1) Rebuild agents to drop UNIQUE(repo_id, name) and add the new columns.
CREATE TABLE agents_new (
  id                 TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,                      -- agent type
  display_name       TEXT NOT NULL,                      -- user label
  enabled            INTEGER NOT NULL DEFAULT 1,
  runner_override    TEXT,
  model_override     TEXT,                               -- e.g. 'sonnet-4.5', 'gpt-5.1-codex'
  schedule_cron      TEXT,                               -- derived from schedule_json on save
  schedule_json      TEXT,                               -- {mode: 'event'|'recurring'|'cron'|'manual', ...}
  timeout_ms         INTEGER NOT NULL,
  perm_read_code     INTEGER NOT NULL DEFAULT 1,
  perm_run_tests     INTEGER NOT NULL DEFAULT 1,
  perm_create_issues INTEGER NOT NULL DEFAULT 1,
  perm_draft_prs     INTEGER NOT NULL DEFAULT 1,
  perm_merge         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

INSERT INTO agents_new (
  id, repo_id, name, display_name, enabled, runner_override, model_override,
  schedule_cron, schedule_json, timeout_ms,
  perm_read_code, perm_run_tests, perm_create_issues, perm_draft_prs, perm_merge,
  created_at
)
SELECT
  agents.id,
  agents.repo_id,
  agents.name,
  CASE agents.name
    WHEN 'qa-hunter'       THEN 'QA Hunter'
    WHEN 'manual-qa'       THEN 'Manual QA'
    WHEN 'bug-fixer'       THEN 'Bug Fixer'
    WHEN 'feature-builder' THEN 'Feature Builder'
    WHEN 'pr-reviewer'     THEN 'PR Reviewer'
    WHEN 'ios-qa-pilot'    THEN 'iOS QA Pilot'
    ELSE agents.name
  END,
  agents.enabled,
  agents.runner_override,
  NULL,                                                  -- model_override
  agents.schedule_cron,
  NULL,                                                  -- schedule_json (lazily populated on first save)
  agents.timeout_ms,
  1, 1,                                                   -- read_code, run_tests
  CASE agents.name WHEN 'pr-reviewer' THEN 0 ELSE 1 END,  -- create_issues
  CASE agents.name WHEN 'bug-fixer' THEN 1 WHEN 'feature-builder' THEN 1 ELSE 0 END,  -- draft_prs
  0,                                                      -- merge
  COALESCE(
    (SELECT connected_at FROM repos WHERE repos.id = agents.repo_id),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
CREATE INDEX idx_agents_repo ON agents(repo_id, name);

-- 2) runs.agent_id — scope stats / history per instance.
ALTER TABLE runs ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX idx_runs_agent_id_started ON runs(agent_id, started_at DESC);

-- Best-effort backfill: each historical run gets the (now sole) instance for its
-- (repo_id, agent_name). Multi-instance hadn't shipped yet so this mapping is unique.
UPDATE runs
SET agent_id = (
  SELECT id FROM agents
  WHERE agents.repo_id = runs.repo_id
    AND agents.name    = runs.agent_name
  LIMIT 1
);

-- 3) Drop the FK on backlog.in_progress_run so atomic claims can use a
--    placeholder token at selectTask time (before the run row exists). The
--    column is only ever consulted as an opaque "is this row claimed?" flag;
--    we never JOIN through it.
CREATE TABLE backlog_new (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,
  github_issue      INTEGER,
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  priority_label    TEXT,
  user_pin_rank     INTEGER,
  agent_override    TEXT,
  runner_override   TEXT,
  in_progress_run   TEXT,                                 -- claim token; no FK
  added_at          TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
INSERT INTO backlog_new SELECT * FROM backlog;
DROP TABLE backlog;
ALTER TABLE backlog_new RENAME TO backlog;
CREATE INDEX idx_backlog_repo_rank ON backlog(repo_id, user_pin_rank, priority_label, added_at DESC);

-- 4) pr_review_claims — atomic per-(PR, head_sha) claim for PR Reviewer instances.
--    Two reviewers can run in parallel on different PRs; the same (PR, SHA) is
--    reviewed at most once.
CREATE TABLE pr_review_claims (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number    INTEGER NOT NULL,
  head_sha     TEXT NOT NULL,
  agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  run_id       TEXT,                                     -- not FK; same rationale as qa_ios_flows
  claimed_at   TEXT NOT NULL,
  released_at  TEXT,
  result       TEXT                                      -- done | failed | paused
);
-- Only one ACTIVE claim per (repo, PR, sha):
CREATE UNIQUE INDEX uq_active_pr_review
  ON pr_review_claims(repo_id, pr_number, head_sha)
  WHERE released_at IS NULL;
-- Skip-when-done lookup:
CREATE INDEX idx_pr_review_done
  ON pr_review_claims(repo_id, pr_number, head_sha, result);
