import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun, listLiveRuns } from '../../src/main/db/runs';
import { setSetting, getSetting } from '../../src/main/db/settings';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-cap-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Minimal copies of the predicates the scheduler uses, kept here so the
 * test exercises the real DB-driven inputs without booting the full
 * scheduler timer. Mirrors `tick.ts` exactly — if either implementation
 * drifts, the integration test in `orchestrator-bug-fixer.test.ts`
 * catches the divergence.
 */
const DEFAULT_CAP = 3;
function patchAgentCap(repoId: string): number {
  const override = getSetting<number>(`repo:${repoId}`, 'bug_fixer_cap');
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_CAP;
}

describe('per-repo bug-fixer concurrency cap', () => {
  it('default cap is 3 when no override is set', () => {
    expect(patchAgentCap(repoId)).toBe(3);
  });

  it('honors per-repo override from settings', () => {
    setSetting(`repo:${repoId}`, 'bug_fixer_cap', 5);
    expect(patchAgentCap(repoId)).toBe(5);
  });

  it('falls back to default for non-numeric overrides', () => {
    setSetting(`repo:${repoId}`, 'bug_fixer_cap', 'banana');
    expect(patchAgentCap(repoId)).toBe(DEFAULT_CAP);
  });

  it('falls back to default for non-positive overrides', () => {
    setSetting(`repo:${repoId}`, 'bug_fixer_cap', 0);
    expect(patchAgentCap(repoId)).toBe(DEFAULT_CAP);
  });

  it('listLiveRuns reflects active bug-fixer runs for cap accounting', () => {
    // Seed three live bug-fixer runs across two instances.
    const a1 = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const a2 = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: a1.id,
      trigger: 'schedule',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: a2.id,
      trigger: 'schedule',
      taskRef: 'issue#2',
      runnerUsed: 'claude',
    });
    const r3 = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: a1.id,
      trigger: 'schedule',
      taskRef: 'issue#3',
      runnerUsed: 'claude',
    });

    const live = listLiveRuns(repoId);
    const liveBugFixers = live.filter((r) => r.agentName === 'bug-fixer').length;
    expect(liveBugFixers).toBe(3);

    // The cap (3) is hit — scheduler should not dispatch a fourth.
    const wouldDispatch = liveBugFixers < patchAgentCap(repoId);
    expect(wouldDispatch).toBe(false);

    // Once one finishes, the next dispatch slot opens.
    transitionRun(r3.id, 'done');
    const afterDone = listLiveRuns(repoId).filter((r) => r.agentName === 'bug-fixer').length;
    expect(afterDone).toBe(2);
    expect(afterDone < patchAgentCap(repoId)).toBe(true);
  });

  it('cap is per-(repoId, agentName) — feature-builder runs do not count toward bug-fixer cap', () => {
    const a1 = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const a2 = createAgent({ repoId, name: 'feature-builder', enabled: true });
    createRun({
      repoId,
      agentName: 'feature-builder',
      agentId: a2.id,
      trigger: 'schedule',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    createRun({
      repoId,
      agentName: 'feature-builder',
      agentId: a2.id,
      trigger: 'schedule',
      taskRef: 'issue#2',
      runnerUsed: 'claude',
    });
    createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: a1.id,
      trigger: 'schedule',
      taskRef: 'issue#3',
      runnerUsed: 'claude',
    });

    const live = listLiveRuns(repoId);
    const bugFixerCount = live.filter((r) => r.agentName === 'bug-fixer').length;
    const featureBuilderCount = live.filter((r) => r.agentName === 'feature-builder').length;
    expect(bugFixerCount).toBe(1);
    expect(featureBuilderCount).toBe(2);
    // Both are below the cap of 3 in their own bucket.
    expect(bugFixerCount < patchAgentCap(repoId)).toBe(true);
    expect(featureBuilderCount < patchAgentCap(repoId)).toBe(true);
  });
});
