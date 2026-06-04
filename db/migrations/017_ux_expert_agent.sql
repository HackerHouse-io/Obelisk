-- Backfill a UI/UX Expert agent into every repo that doesn't already have one,
-- so the agent appears in the Agents list (instead of "Not installed") for
-- repos connected before the agent shipped.
--
-- `ux-expert` is brand-new in this release, so a repo lacking one is always a
-- pre-existing repo — never a user deletion. That makes an unconditional
-- backfill safe (unlike a blanket "re-seed all defaults", which would resurrect
-- agents a user intentionally removed).
--
-- Defaults mirror createAgent's connect-time seeding:
--   * enabled = 0 — paused by default ("off by default" stance, migration 004);
--     the user enables it from Configure.
--   * schedule_cron = NULL — the scheduler falls back to defaultCronFor('ux-expert').
--   * timeout_ms = 2700000 (45 min) — DEFAULT_TIMEOUT['ux-expert'], matching Manual QA.
--   * perms: read code + run tests + create issues; no PRs, no merge (read-only QA agent).

INSERT INTO agents (
  id, repo_id, name, display_name, enabled, runner_override, model_override,
  schedule_cron, schedule_json, timeout_ms,
  perm_read_code, perm_run_tests, perm_create_issues, perm_draft_prs, perm_merge,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  repos.id,
  'ux-expert',
  'UI/UX Expert',
  0,
  NULL, NULL,
  NULL, NULL,
  2700000,
  1, 1, 1, 0, 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM repos
WHERE NOT EXISTS (
  SELECT 1 FROM agents WHERE agents.repo_id = repos.id AND agents.name = 'ux-expert'
);
