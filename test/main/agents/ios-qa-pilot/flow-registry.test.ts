import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import {
  bumpRepoCycle,
  claimNextFlow,
  ensureRepoState,
  listFlows,
  recordFlowOutcome,
  resetFlows,
  syncFlows,
} from '../../../../src/main/db/qa-flows';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-registry-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/ios',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
  ensureRepoState(repoId);
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function seed(n: number): string[] {
  const inputs = Array.from({ length: n }, (_, i) => ({
    flowId: `flow-${i.toString().padStart(2, '0')}`,
    repoId,
    title: `Flow ${i}`,
    sourcePath: `qa/ios-flows/flow-${i}.flow.md`,
    bodySha: `sha-${i}`,
  }));
  syncFlows(repoId, inputs);
  return inputs.map((f) => f.flowId);
}

describe('claimNextFlow', () => {
  it('returns null when there is nothing claimable', () => {
    expect(claimNextFlow(repoId, 'run-1')).toBeNull();
  });

  it('claims pending flows in deterministic order', () => {
    seed(2);
    const a = claimNextFlow(repoId, 'run-1');
    const b = claimNextFlow(repoId, 'run-2');
    const c = claimNextFlow(repoId, 'run-3');
    expect(a?.flowId).toBe('flow-00');
    expect(b?.flowId).toBe('flow-01');
    expect(c).toBeNull();
  });

  it('prefers failed flows over pending ones (re-test what we know is broken)', () => {
    seed(2);
    // Mark flow-01 as failed without an active claim.
    const c1 = claimNextFlow(repoId, 'run-x')!;
    recordFlowOutcome({ flowId: c1.flowId, runId: 'run-x', status: 'failed', findingCount: 1 });
    const next = claimNextFlow(repoId, 'run-y');
    expect(next?.flowId).toBe(c1.flowId);
  });

  it('honors a preferredFlowId when claimable', () => {
    const ids = seed(3);
    const claimed = claimNextFlow(repoId, 'run-1', ids[2]);
    expect(claimed?.flowId).toBe(ids[2]);
  });

  it('atomic under concurrent calls — exactly N callers win for N rows', async () => {
    seed(2);
    // Run concurrent claims — better-sqlite3 transactions serialize writes,
    // but we still want the contract to be exactly-once-per-row.
    const results = await Promise.all([
      Promise.resolve(claimNextFlow(repoId, 'run-1')),
      Promise.resolve(claimNextFlow(repoId, 'run-2')),
      Promise.resolve(claimNextFlow(repoId, 'run-3')),
      Promise.resolve(claimNextFlow(repoId, 'run-4')),
    ]);
    const wins = results.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(wins).toHaveLength(2);
    const claimedIds = wins.map((w) => w.flowId).sort();
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
  });
});

describe('recordFlowOutcome', () => {
  it('drops the writeback when the cycle no longer matches (post-reset)', () => {
    seed(1);
    const flow = claimNextFlow(repoId, 'run-1')!;
    expect(flow.status).toBe('running');

    bumpRepoCycle(repoId); // simulate reset between claim and writeback

    const wrote = recordFlowOutcome({
      flowId: flow.flowId,
      runId: 'run-1',
      status: 'passed',
      findingCount: 0,
    });
    expect(wrote).toBe(false);

    // Row is still claimed (the stale-claim sweeper would handle it later).
    const after = listFlows(repoId)[0]!;
    expect(after.status).toBe('running');
  });

  it('only the claiming run can release the row', () => {
    seed(1);
    const flow = claimNextFlow(repoId, 'run-real')!;
    const wrote = recordFlowOutcome({
      flowId: flow.flowId,
      runId: 'run-impostor',
      status: 'passed',
      findingCount: 0,
    });
    expect(wrote).toBe(false);
  });
});

describe('resetFlows', () => {
  it('unverified scope: bumps cycle and demotes only unclaimed rows', () => {
    seed(2);
    const claimed = claimNextFlow(repoId, 'run-1')!;
    const before = listFlows(repoId);
    expect(before.find((f) => f.status === 'running')).toBeTruthy();

    const out = resetFlows(repoId, 'unverified');
    expect(out.cycle).toBeGreaterThan(0);

    const after = listFlows(repoId);
    const stillClaimed = after.find((f) => f.flowId === claimed.flowId);
    expect(stillClaimed?.status).toBe('running'); // not touched
    const unclaimed = after.filter((f) => f.flowId !== claimed.flowId);
    expect(unclaimed.every((f) => f.status === 'pending')).toBe(true);
  });

  it('all scope: clears claim on running rows too', () => {
    seed(2);
    claimNextFlow(repoId, 'run-1');
    resetFlows(repoId, 'all');
    const after = listFlows(repoId);
    expect(after.every((f) => f.status === 'pending')).toBe(true);
    expect(after.every((f) => f.claimedRunId === null)).toBe(true);
  });
});
