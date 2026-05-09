-- Phase 1.1: bug-fixer refinement.
--
-- Lets backlog-sync upsert GitHub issues into the backlog table without a
-- transactional dance. Two sweeps that race insert the same issue still
-- end up with one row thanks to ON CONFLICT(repo_id, github_issue) WHERE
-- source = 'gh_issue' DO UPDATE.
--
-- Manual rows (source='manual') are excluded because their github_issue is
-- always NULL and (repo_id, NULL) is not a useful uniqueness key.

PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX IF NOT EXISTS uq_backlog_gh_issue
  ON backlog(repo_id, github_issue)
  WHERE source = 'gh_issue';
