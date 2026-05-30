-- Coverage Agent autonomous-loop bookkeeping.
--
-- One `coverage_runs` row per pass (manual button or scheduled sweep). It
-- sequences existing primitives — coverage-map generation, test-plan
-- generation, and qa-hunter runs — so it spawns no CLI of its own; the row
-- just tracks which stage the pass is in, how much of its per-pass spawn
-- budget it has used, and the terminal outcome.
--
-- `coverage_run_steps` is the per-pass timeline: one row per spawned unit of
-- work (a map job, a plan-generation job, or a hunt run) for the UI and for
-- restart reconciliation.

CREATE TABLE coverage_runs (
  id              TEXT PRIMARY KEY,            -- cov-<ulid>
  repo_id         TEXT NOT NULL,
  trigger         TEXT NOT NULL,               -- 'manual' | 'schedule'
  stage           TEXT NOT NULL,               -- queued|mapping|detecting|drafting|hunting|done|failed|cancelled
  status          TEXT,                        -- human-readable label for the UI
  budget_spawns   INTEGER NOT NULL DEFAULT 8,  -- hard cap on CLI spawns this pass
  spawns_used     INTEGER NOT NULL DEFAULT 0,
  gap_threshold   INTEGER NOT NULL DEFAULT 70, -- features below this coveragePct are "gaps"
  cancel_requested INTEGER NOT NULL DEFAULT 0, -- set by cancelCoverageRun; polled between awaits
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error_message   TEXT,
  error_hint      TEXT
);

CREATE INDEX idx_coverage_runs_repo ON coverage_runs (repo_id, started_at DESC);

CREATE TABLE coverage_run_steps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  coverage_run_id   TEXT NOT NULL REFERENCES coverage_runs (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,             -- 'map' | 'generate' | 'hunt'
  feature_label     TEXT,
  ref               TEXT,                      -- jobId or runId of the spawned work
  state             TEXT NOT NULL,             -- pending|running|done|failed|skipped
  detail            TEXT,
  at                TEXT NOT NULL
);

CREATE INDEX idx_coverage_run_steps_parent ON coverage_run_steps (coverage_run_id);
