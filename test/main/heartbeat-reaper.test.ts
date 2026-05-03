import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, getRun } from '../../src/main/db/runs';
import { reapStaleRuns } from '../../src/main/scheduler/heartbeat-reaper';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-reap-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
  // 30-min timeout — `reaper` cutoff is 2× = 60 min.
  createAgent({ repoId, name: 'bug-fixer', timeoutMs: 30 * 60 * 1000 });
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function setHeartbeat(runId: string, state: string, minutesAgo: number): void {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  getDb()
    .prepare('UPDATE runs SET state = ?, last_heartbeat_at = ? WHERE id = ?')
    .run(state, at, runId);
}

function newRun(taskRef: string): { id: string } {
  return createRun({
    repoId,
    agentName: 'bug-fixer',
    trigger: 'manual',
    taskRef,
    runnerUsed: 'claude',
  });
}

describe('reapStaleRuns', () => {
  it('reaps a running run whose heartbeat is older than 2× timeout', () => {
    const run = newRun('manual:test');
    // 90-min-old heartbeat is past the 60-min cutoff (2× the 30-min timeout).
    setHeartbeat(run.id, 'running', 90);

    const result = reapStaleRuns();
    expect(result.reaped).toContain(run.id);
    const after = getRun(run.id);
    expect(after?.state).toBe('failed');
    expect(after?.errorCode).toBe('TIMEOUT');
  });

  it('leaves fresh runs alone', () => {
    const run = newRun('manual:fresh');
    setHeartbeat(run.id, 'running', 5);

    expect(reapStaleRuns().reaped).toEqual([]);
    expect(getRun(run.id)?.state).toBe('running');
  });

  it('does not reap runs already in a terminal state', () => {
    const run = newRun('manual:done');
    setHeartbeat(run.id, 'done', 90);

    expect(reapStaleRuns().reaped).toEqual([]);
    expect(getRun(run.id)?.state).toBe('done');
  });
});
