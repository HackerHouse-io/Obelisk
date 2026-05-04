import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import {
  claimPrReview,
  releasePrReviewClaim,
  wasReviewed,
  releaseClaimsForRun,
  attachRunToPrReviewClaim,
} from '../../src/main/db/pr-review-claims';

let tmp: string;
let repoId: string;
let agentA: string;
let agentB: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-pr-claim-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
  agentA = createAgent({ repoId, name: 'pr-reviewer', displayName: 'Reviewer 1' }).id;
  agentB = createAgent({ repoId, name: 'pr-reviewer', displayName: 'Reviewer 2' }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('claimPrReview', () => {
  it('first caller wins, second caller for same (PR, sha) gets null', () => {
    const a = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    const b = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentB });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('different PRs claimable by different instances in parallel', () => {
    const a = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    const b = claimPrReview({ repoId, prNumber: 2, headSha: 'sha2', agentId: agentB });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it('different head SHAs of the same PR are independent claims', () => {
    const a = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    expect(a).not.toBeNull();
    releasePrReviewClaim(a!.id, 'done');
    // Force-push: same PR, new SHA. Must be claimable.
    const b = claimPrReview({ repoId, prNumber: 1, headSha: 'sha2', agentId: agentB });
    expect(b).not.toBeNull();
  });

  it('done claims block re-review of the same SHA', () => {
    const a = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    releasePrReviewClaim(a!.id, 'done');
    expect(wasReviewed(repoId, 1, 'sha1')).toBe(true);
    expect(claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentB })).toBeNull();
  });

  it('failed claims do NOT block — a retry is welcome', () => {
    const a = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    releasePrReviewClaim(a!.id, 'failed');
    const b = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentB });
    expect(b).not.toBeNull();
  });

  it('releaseClaimsForRun frees claims on heartbeat reaping', () => {
    const claim = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentA });
    expect(claim).not.toBeNull();
    attachRunToPrReviewClaim(claim!.id, 'run-x');
    releaseClaimsForRun('run-x');
    // After release, the same agent (or another) can re-claim.
    const recovered = claimPrReview({ repoId, prNumber: 1, headSha: 'sha1', agentId: agentB });
    expect(recovered).not.toBeNull();
  });

  it('10 concurrent claims for one PR/SHA — exactly one wins', () => {
    const winners: Array<NonNullable<ReturnType<typeof claimPrReview>>> = [];
    for (let i = 0; i < 10; i++) {
      const c = claimPrReview({ repoId, prNumber: 7, headSha: 'sha-z', agentId: agentA });
      if (c) winners.push(c);
    }
    expect(winners.length).toBe(1);
  });
});
