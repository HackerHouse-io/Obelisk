import { ulid } from 'ulid';
import { getDb } from './index';

/**
 * PR Reviewer claims a (repo, PR, head_sha) tuple before it starts reviewing.
 * The partial-unique index `uq_active_pr_review` guarantees that only one
 * reviewer instance can hold an active claim at a time, even when two ticks
 * fire concurrently. Done claims (released_at IS NOT NULL AND result='done')
 * stay in the table to block re-review of the same SHA on later ticks.
 */

export interface PrReviewClaim {
  id: string;
  repoId: string;
  prNumber: number;
  headSha: string;
  agentId: string | null;
  runId: string | null;
  claimedAt: string;
  releasedAt: string | null;
  result: 'done' | 'failed' | 'paused' | null;
}

interface ClaimRow {
  id: string;
  repo_id: string;
  pr_number: number;
  head_sha: string;
  agent_id: string | null;
  run_id: string | null;
  claimed_at: string;
  released_at: string | null;
  result: 'done' | 'failed' | 'paused' | null;
}

function mapRow(r: ClaimRow): PrReviewClaim {
  return {
    id: r.id,
    repoId: r.repo_id,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    agentId: r.agent_id,
    runId: r.run_id,
    claimedAt: r.claimed_at,
    releasedAt: r.released_at,
    result: r.result,
  };
}

export interface ClaimInput {
  repoId: string;
  prNumber: number;
  headSha: string;
  agentId: string;
}

/**
 * Try to claim a (repo, PR, sha) for review. Returns the claim row when this
 * caller acquired it, or `null` when another caller already holds an active
 * claim or the SHA was already reviewed to completion.
 */
export function claimPrReview(input: ClaimInput): PrReviewClaim | null {
  if (wasReviewed(input.repoId, input.prNumber, input.headSha)) return null;
  const id = ulid();
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO pr_review_claims
        (id, repo_id, pr_number, head_sha, agent_id, run_id, claimed_at, released_at, result)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)
       ON CONFLICT DO NOTHING`,
    )
    .run(id, input.repoId, input.prNumber, input.headSha, input.agentId, now);
  if (result.changes === 0) return null;
  const row = getDb()
    .prepare<[string], ClaimRow>('SELECT * FROM pr_review_claims WHERE id = ?')
    .get(id);
  return row ? mapRow(row) : null;
}

/** Attach a run id to an already-acquired claim once the run row exists. */
export function attachRunToPrReviewClaim(claimId: string, runId: string): void {
  getDb()
    .prepare('UPDATE pr_review_claims SET run_id = ? WHERE id = ?')
    .run(runId, claimId);
}

/** Has any agent successfully reviewed this (repo, PR, sha) yet? */
export function wasReviewed(repoId: string, prNumber: number, headSha: string): boolean {
  const row = getDb()
    .prepare<
      [string, number, string],
      { c: number }
    >(
      `SELECT COUNT(*) AS c FROM pr_review_claims
       WHERE repo_id = ? AND pr_number = ? AND head_sha = ? AND result = 'done'`,
    )
    .get(repoId, prNumber, headSha);
  return (row?.c ?? 0) > 0;
}

export function releasePrReviewClaim(
  claimId: string,
  result: 'done' | 'failed' | 'paused',
): void {
  getDb()
    .prepare('UPDATE pr_review_claims SET released_at = ?, result = ? WHERE id = ?')
    .run(new Date().toISOString(), result, claimId);
}

/** Release any active claims owned by this run — used by the heartbeat reaper. */
export function releaseClaimsForRun(runId: string): void {
  getDb()
    .prepare(
      `UPDATE pr_review_claims SET released_at = ?, result = 'failed'
       WHERE run_id = ? AND released_at IS NULL`,
    )
    .run(new Date().toISOString(), runId);
}
