import { ulid } from 'ulid';
import { getDb } from './index';
import type { AgentName, BacklogItem, RunnerKind } from '../../shared/types';

interface BacklogRow {
  id: string;
  repo_id: string;
  source: 'gh_issue' | 'manual';
  github_issue: number | null;
  title: string;
  kind: 'bug' | 'feature';
  priority_label: 'P0' | 'P1' | 'P2' | null;
  user_pin_rank: number | null;
  agent_override: AgentName | null;
  runner_override: RunnerKind | null;
  in_progress_run: string | null;
  added_at: string;
  last_seen_at: string;
}

function mapRow(r: BacklogRow): BacklogItem {
  return {
    id: r.id,
    repoId: r.repo_id,
    source: r.source,
    githubIssue: r.github_issue,
    title: r.title,
    kind: r.kind,
    priorityLabel: r.priority_label,
    userPinRank: r.user_pin_rank,
    agentOverride: r.agent_override,
    runnerOverride: r.runner_override,
    inProgressRun: r.in_progress_run,
  };
}

/**
 * List the backlog ordered by ranking signals (PRD §3.6):
 *   1. user_pin_rank (NULLS LAST, lower = higher priority)
 *   2. priority_label (P0 > P1 > P2 > NULL)
 *   3. added_at DESC
 */
export function listBacklog(repoId: string): BacklogItem[] {
  return getDb()
    .prepare<[string], BacklogRow>(
      `SELECT * FROM backlog
       WHERE repo_id = ?
       ORDER BY
         user_pin_rank IS NULL,
         user_pin_rank ASC,
         CASE priority_label WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         added_at DESC`,
    )
    .all(repoId)
    .map(mapRow);
}

/** Pick the highest-ranked backlog item of the given kind that's not already in flight. */
export function nextAvailable(repoId: string, kind: 'bug' | 'feature'): BacklogItem | null {
  const row = getDb()
    .prepare<[string, string], BacklogRow>(
      `SELECT * FROM backlog
       WHERE repo_id = ? AND kind = ? AND in_progress_run IS NULL
       ORDER BY
         user_pin_rank IS NULL,
         user_pin_rank ASC,
         CASE priority_label WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         added_at DESC
       LIMIT 1`,
    )
    .get(repoId, kind);
  return row ? mapRow(row) : null;
}

export interface CreateBacklogInput {
  repoId: string;
  source: 'gh_issue' | 'manual';
  githubIssue?: number | null;
  title: string;
  kind: 'bug' | 'feature';
  priorityLabel?: 'P0' | 'P1' | 'P2' | null;
  agentOverride?: AgentName | null;
  runnerOverride?: RunnerKind | null;
}

export function createBacklogItem(input: CreateBacklogInput): BacklogItem {
  const id = ulid();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO backlog
        (id, repo_id, source, github_issue, title, kind,
         priority_label, user_pin_rank, agent_override, runner_override,
         in_progress_run, added_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.source,
      input.githubIssue ?? null,
      input.title,
      input.kind,
      input.priorityLabel ?? null,
      input.agentOverride ?? null,
      input.runnerOverride ?? null,
      now,
      now,
    );
  const row = getDb().prepare<[string], BacklogRow>('SELECT * FROM backlog WHERE id = ?').get(id);
  if (!row) throw new Error('createBacklogItem: row vanished');
  return mapRow(row);
}

export function getBacklogItem(id: string): BacklogItem | null {
  const row = getDb().prepare<[string], BacklogRow>('SELECT * FROM backlog WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/** Lock a backlog item to a specific run so no other tick picks it up. */
export function lockBacklogItem(id: string, runId: string): void {
  getDb()
    .prepare('UPDATE backlog SET in_progress_run = ?, last_seen_at = ? WHERE id = ?')
    .run(runId, new Date().toISOString(), id);
}

/**
 * Atomically pick + lock the highest-ranked backlog item of `kind` that's not
 * already in flight, marking it as owned by `runId`. Replaces the
 * `nextAvailable` + `lockBacklogItem` pair so two parallel runners can't both
 * grab the same row (TOCTOU). SQLite 3.35 RETURNING gives us this in one trip.
 */
export function claimNextBacklogItem(
  repoId: string,
  kind: 'bug' | 'feature',
  runId: string,
): BacklogItem | null {
  const row = getDb()
    .prepare<[string, string, string, string], BacklogRow>(
      `UPDATE backlog
       SET in_progress_run = ?, last_seen_at = ?
       WHERE id = (
         SELECT id FROM backlog
         WHERE repo_id = ? AND kind = ? AND in_progress_run IS NULL
         ORDER BY
           user_pin_rank IS NULL,
           user_pin_rank ASC,
           CASE priority_label WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
           added_at DESC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(runId, new Date().toISOString(), repoId, kind);
  return row ? mapRow(row) : null;
}

export function unlockBacklogItem(id: string): void {
  getDb()
    .prepare('UPDATE backlog SET in_progress_run = NULL, last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export interface UpsertBacklogFromGithubInput {
  repoId: string;
  githubIssue: number;
  title: string;
  kind: 'bug' | 'feature';
  priorityLabel: 'P0' | 'P1' | 'P2' | null;
}

/**
 * Idempotent upsert keyed on (repo_id, github_issue) for source='gh_issue'.
 * Used by the periodic backlog-sync sweep — two sweeps that race still end
 * with a single row thanks to migration 007's partial unique index.
 *
 * `added_at` only sets on first insert (DO UPDATE leaves it alone), so
 * ranking by `added_at DESC` keeps reflecting when we *first* learned of
 * the issue, not the last sync time.
 */
export function upsertBacklogFromGithub(input: UpsertBacklogFromGithubInput): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO backlog
        (id, repo_id, source, github_issue, title, kind,
         priority_label, user_pin_rank, agent_override, runner_override,
         in_progress_run, added_at, last_seen_at)
       VALUES (?, ?, 'gh_issue', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(repo_id, github_issue) WHERE source = 'gh_issue'
       DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         priority_label = excluded.priority_label,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(
      ulid(),
      input.repoId,
      input.githubIssue,
      input.title,
      input.kind,
      input.priorityLabel,
      now,
      now,
    );
}

/**
 * Drop a `source='gh_issue'` backlog row for a known-closed issue. Called by
 * agent selectTask when it discovers the row points at a closed/locked
 * issue, so the next claim attempt doesn't keep tripping over it. Safe no-op
 * if the row is currently `in_progress_run` — we don't want to yank a row
 * out from under a live run.
 */
export function deleteBacklogGhIssue(repoId: string, githubIssue: number): void {
  getDb()
    .prepare(
      `DELETE FROM backlog
        WHERE repo_id = ? AND github_issue = ? AND source = 'gh_issue'
          AND in_progress_run IS NULL`,
    )
    .run(repoId, githubIssue);
}

export function reorderBacklog(repoId: string, orderedIds: string[]): void {
  const stmt = getDb().prepare('UPDATE backlog SET user_pin_rank = ? WHERE repo_id = ? AND id = ?');
  const tx = getDb().transaction((ids: string[]) => {
    for (let i = 0; i < ids.length; i += 1) {
      stmt.run(i + 1, repoId, ids[i]);
    }
  });
  tx(orderedIds);
}

export function setBacklogOverride(
  id: string,
  patch: { agentOverride?: AgentName | null; runnerOverride?: RunnerKind | null },
): BacklogItem {
  const row = getDb().prepare<[string], BacklogRow>('SELECT * FROM backlog WHERE id = ?').get(id);
  if (!row) throw new Error(`setBacklogOverride: ${id} not found`);
  const agentOverride =
    patch.agentOverride === undefined ? row.agent_override : patch.agentOverride;
  const runnerOverride =
    patch.runnerOverride === undefined ? row.runner_override : patch.runnerOverride;
  getDb()
    .prepare('UPDATE backlog SET agent_override = ?, runner_override = ? WHERE id = ?')
    .run(agentOverride, runnerOverride, id);
  const next = getDb().prepare<[string], BacklogRow>('SELECT * FROM backlog WHERE id = ?').get(id);
  if (!next) throw new Error('setBacklogOverride: row vanished');
  return mapRow(next);
}
