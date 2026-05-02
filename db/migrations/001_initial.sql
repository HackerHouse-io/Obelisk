-- Obelisk schema — initial migration.
-- Source of truth: docs/TECH_DESIGN.md §4.1, plus actor_allowlist (PLAN.md / safety control).

PRAGMA foreign_keys = ON;

-- Each connected repo.
CREATE TABLE IF NOT EXISTS repos (
  id                TEXT PRIMARY KEY,           -- ulid
  github_full_name  TEXT NOT NULL UNIQUE,       -- "owner/name"
  local_path        TEXT NOT NULL,
  default_branch    TEXT NOT NULL,
  mode              TEXT NOT NULL,              -- observe | issues | prs | automerge
  default_runner    TEXT NOT NULL,              -- claude | codex
  connected_at      TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(github_full_name);

-- Per-repo agent installation + per-agent overrides.
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,              -- qa-hunter | manual-qa | bug-fixer | feature-builder | pr-reviewer
  enabled           INTEGER NOT NULL DEFAULT 1,
  runner_override   TEXT,                       -- NULL = use repo default
  schedule_cron     TEXT,                       -- NULL = use built-in default for this agent
  timeout_ms        INTEGER NOT NULL,
  UNIQUE(repo_id, name)
);

-- One row per agent run, regardless of outcome.
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  agent_name        TEXT NOT NULL,
  state             TEXT NOT NULL,              -- queued | running | publishing | done | failed | paused
  started_at        TEXT,
  finished_at       TEXT,
  last_heartbeat_at TEXT,
  trigger           TEXT NOT NULL,              -- schedule | manual | webhook | cloud
  task_ref          TEXT,                       -- e.g. issue#123, pr#456
  runner_used       TEXT NOT NULL,
  fallback_used     INTEGER NOT NULL DEFAULT 0,
  output_summary    TEXT,
  error_code        TEXT,
  worktree_path     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_repo_agent_started ON runs(repo_id, agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);

-- Append-only run log; one row per significant event.
CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at                TEXT NOT NULL,
  kind              TEXT NOT NULL,              -- state | tool_call | file_read | file_write | test_run | api_call | reasoning | actor_skipped | qa_finding | repro_attempt | evidence_check | flow_run | oracle_skipped | loop_step | spec_posted | plan_posted | review_finding | evidence_cross_check | dup_skipped
  payload           TEXT NOT NULL               -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_log_run ON audit_log(run_id, id);

-- Files produced by a run: patches, screenshots, traces, logs.
CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,              -- patch | test_output | screenshot | trace | log | reasoning | failing_test_diff | curl_log
  path              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  uploaded_to_repo  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_run ON evidence_artifacts(run_id);

-- Prioritized backlog feeding Bug Fixer + Feature Builder.
CREATE TABLE IF NOT EXISTS backlog (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,              -- gh_issue | manual
  github_issue      INTEGER,
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL,              -- bug | feature
  priority_label    TEXT,                       -- P0 | P1 | P2 | NULL
  user_pin_rank     INTEGER,
  agent_override    TEXT,
  runner_override   TEXT,
  in_progress_run   TEXT REFERENCES runs(id),
  added_at          TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_repo_rank ON backlog(repo_id, user_pin_rank, priority_label, added_at DESC);

-- App-wide and per-repo settings.
CREATE TABLE IF NOT EXISTS settings (
  scope             TEXT NOT NULL,              -- 'app' | 'repo:<id>'
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,              -- JSON
  PRIMARY KEY (scope, key)
);

-- Per-repo skill overrides catalog.
CREATE TABLE IF NOT EXISTS skill_overrides (
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  skill_name        TEXT NOT NULL,
  source_path       TEXT NOT NULL,
  PRIMARY KEY (repo_id, skill_name)
);

-- Learned QA rules from user accept/reject decisions.
CREATE TABLE IF NOT EXISTS non_bugs_learned (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  rule              TEXT NOT NULL,
  source_run        TEXT REFERENCES runs(id),
  added_at          TEXT NOT NULL
);

-- Per-repo allowlist of GitHub logins whose issues/PRs/comments may trigger agent runs.
-- Hard gate at selectTask time. See PLAN.md "Actor allowlist" section.
CREATE TABLE IF NOT EXISTS actor_allowlist (
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  login             TEXT NOT NULL,              -- GitHub login (lowercase)
  added_at          TEXT NOT NULL,
  added_by          TEXT NOT NULL,              -- 'auto' on first connect, else the login that added them
  PRIMARY KEY (repo_id, login)
);
