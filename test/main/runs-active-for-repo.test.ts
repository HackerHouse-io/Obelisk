import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { handleRunsActiveForRepo } from '../../src/main/ipc/runs';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-runs-active-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runs:activeForRepo IPC', () => {
  it('returns only live (queued/running/publishing/paused) runs', async () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const liveRun = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: 'plan:LIVE',
      runnerUsed: 'claude',
    });

    const finishedRun = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: 'plan:DONE',
      runnerUsed: 'claude',
    });
    transitionRun(finishedRun.id, 'done', { outputSummary: 'ok' });

    const failedRun = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: 'plan:FAILED',
      runnerUsed: 'claude',
    });
    transitionRun(failedRun.id, 'failed', { errorCode: 'INTERNAL' });

    const result = await handleRunsActiveForRepo({ repoId });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      runId: liveRun.id,
      agentName: 'qa-hunter',
      taskRef: 'plan:LIVE',
      state: 'queued',
    });
  });

  it('includes paused runs (paused is not terminal — the lock is still held)', async () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const r = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: 'plan:PAUSED',
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'paused');

    const result = await handleRunsActiveForRepo({ repoId });
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe('paused');
  });

  it("does not return runs from a different repo", async () => {
    const other = createRepo({
      githubFullName: 'test/y',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const a = createAgent({ repoId: other.id, name: 'qa-hunter' });
    createRun({
      repoId: other.id,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: 'plan:ELSEWHERE',
      runnerUsed: 'claude',
    });

    const result = await handleRunsActiveForRepo({ repoId });
    expect(result).toEqual([]);
  });
});
