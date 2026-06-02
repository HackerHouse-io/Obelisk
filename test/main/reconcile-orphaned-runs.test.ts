import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, getRun, transitionRun, reconcileOrphanedRuns } from '../../src/main/db/runs';
import { claimPrReview, attachRunToPrReviewClaim } from '../../src/main/db/pr-review-claims';
import { createBacklogItem, lockBacklogItem, getBacklogItem } from '../../src/main/db/backlog';
import type { RunState } from '../../src/shared/types';

let tmp: string;
let repoId: string;
let agentId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-reconcile-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
  agentId = createAgent({
    repoId,
    name: 'bug-fixer',
    displayName: 'Bug Fixer',
    runnerOverride: null,
    scheduleCron: null,
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function newRun(taskRef: string, state: RunState): string {
  const r = createRun({
    repoId,
    agentName: 'bug-fixer',
    agentId,
    trigger: 'manual',
    taskRef,
    runnerUsed: 'claude',
  });
  if (state !== 'queued') transitionRun(r.id, state);
  return r.id;
}

describe('reconcileOrphanedRuns', () => {
  it('fails orphaned active runs (queued/running/publishing) as INTERRUPTED', () => {
    const queued = newRun('issue#1', 'queued');
    const running = newRun('issue#2', 'running');
    const publishing = newRun('issue#3', 'publishing');

    expect(reconcileOrphanedRuns()).toBe(3);

    for (const id of [queued, running, publishing]) {
      const after = getRun(id);
      expect(after?.state).toBe('failed');
      expect(after?.errorCode).toBe('INTERRUPTED');
      expect(after?.outputSummary).toBe('Interrupted by an app restart.');
      expect(after?.finishedAt).not.toBeNull();
    }
  });

  it('leaves paused and terminal runs untouched', () => {
    const paused = newRun('issue#10', 'paused');
    const done = newRun('issue#11', 'done');
    const failed = newRun('issue#12', 'failed');
    const cancelled = newRun('issue#13', 'cancelled');

    expect(reconcileOrphanedRuns()).toBe(0);

    expect(getRun(paused)?.state).toBe('paused');
    expect(getRun(done)?.state).toBe('done');
    expect(getRun(failed)?.state).toBe('failed');
    expect(getRun(cancelled)?.state).toBe('cancelled');
  });

  it('releases the PR-review claim and backlog lock held by an orphaned run', () => {
    const runId = newRun('pr#5@sha', 'running');

    const claim = claimPrReview({ repoId, prNumber: 5, headSha: 'sha', agentId });
    expect(claim).not.toBeNull();
    attachRunToPrReviewClaim(claim!.id, runId);

    const item = createBacklogItem({ repoId, source: 'manual', title: 'x', kind: 'bug' });
    lockBacklogItem(item.id, runId);

    reconcileOrphanedRuns();

    const claimRow = getDb()
      .prepare<[string], { released_at: string | null; result: string | null }>(
        'SELECT released_at, result FROM pr_review_claims WHERE id = ?',
      )
      .get(claim!.id);
    expect(claimRow?.released_at).not.toBeNull();
    expect(claimRow?.result).toBe('failed');

    expect(getBacklogItem(item.id)?.inProgressRun).toBeNull();
  });
});
