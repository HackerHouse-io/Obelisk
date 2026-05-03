-- iOS QA Pilot — flow registry, simulator pool, and rename-migration audit.
-- Source of truth: plans/you-are-a-staff-wild-wolf.md.
--
-- Tables added:
--   qa_ios_repo_state          per-repo cycle counter + setup timestamp
--   qa_ios_flows               flow registry (atomic claim, status, body_sha)
--   qa_ios_sim_slots           fixed pool of cloned simulators (UDID + ports)
--   qa_ios_flow_id_migrations  audit when a flow's id changes after rename

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS qa_ios_repo_state (
  repo_id    TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  cycle      INTEGER NOT NULL DEFAULT 0,
  setup_at   TEXT
);

-- Note: `claimed_run_id` and `last_run_id` deliberately have NO foreign-key
-- constraint. The agent's `selectTask` claims a flow BEFORE the orchestrator
-- creates the `runs` row, so the value is a temp token at first. Once the
-- run completes, recordFlowOutcome stores the real run id; if a run is
-- deleted later, we leave the historical reference dangling rather than
-- erasing run history.
CREATE TABLE IF NOT EXISTS qa_ios_flows (
  flow_id          TEXT PRIMARY KEY,                            -- sha1(repoId|sourcePath|title)[:16]
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  body_sha         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','passed','failed','inconclusive','outdated')),
  cycle            INTEGER NOT NULL DEFAULT 0,
  claimed_run_id   TEXT,
  claimed_at       TEXT,
  last_run_id      TEXT,
  last_verified_at TEXT,
  finding_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qa_ios_flows_repo_status ON qa_ios_flows(repo_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_ios_flows_claim
  ON qa_ios_flows(claimed_run_id) WHERE claimed_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qa_ios_flows_body_sha ON qa_ios_flows(repo_id, body_sha);

CREATE TABLE IF NOT EXISTS qa_ios_sim_slots (
  slot_index     INTEGER PRIMARY KEY,
  udid           TEXT NOT NULL,
  appium_port    INTEGER NOT NULL,
  wda_port       INTEGER NOT NULL,
  claimed_run_id TEXT UNIQUE,                                   -- not FK; same reason as qa_ios_flows
  claimed_at     TEXT
);

CREATE TABLE IF NOT EXISTS qa_ios_flow_id_migrations (
  new_id       TEXT PRIMARY KEY,
  old_id       TEXT NOT NULL,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  migrated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_ios_flow_id_migrations_repo ON qa_ios_flow_id_migrations(repo_id);
