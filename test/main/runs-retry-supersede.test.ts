import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub the dispatch core so the retry path doesn't hit the runner pre-flight
// (which depends on whether claude/codex are on PATH) or drive a real run.
// `vi.hoisted` so the mock fn exists when the hoisted `vi.mock` factory runs.
const { dispatchAgentRun } = vi.hoisted(() => ({
  dispatchAgentRun: vi.fn(async () => ({
    runId: 'new-run',
    taskRef: 'issue#22',
    taskContext: null,
  })),
}));
vi.mock('../../src/main/ipc/agents', () => ({ dispatchAgentRun }));

import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, getRun, transitionRun } from '../../src/main/db/runs';
import { handleRunsRetry } from '../../src/main/ipc/runs';

let tmp: string;
let repoId: string;
let agentId: string;

beforeEach(() => {
  dispatchAgentRun.mockClear();
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-supersede-'));
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

describe('handleRunsRetry — superseding a paused run', () => {
  it('cancels the paused run before dispatch so the task ref is free', async () => {
    const run = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'issue#22',
      runnerUsed: 'claude',
    });
    transitionRun(run.id, 'paused', { errorCode: 'EVIDENCE_INCOMPLETE' });

    await handleRunsRetry({ runId: run.id });

    // Old run is released from its single-flight lock...
    const after = getRun(run.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.outputSummary).toBe('Superseded by retry.');

    // ...and the retry re-dispatched the same task with forceTask + linkage.
    expect(dispatchAgentRun).toHaveBeenCalledTimes(1);
    expect(dispatchAgentRun.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'issue#22',
      forceTask: true,
      retryOfRunId: run.id,
    });
  });

  it('does not cancel a failed run being retried (already terminal)', async () => {
    const run = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'issue#23',
      runnerUsed: 'claude',
    });
    transitionRun(run.id, 'failed');

    await handleRunsRetry({ runId: run.id });

    expect(getRun(run.id)?.state).toBe('failed');
    expect(dispatchAgentRun).toHaveBeenCalledTimes(1);
  });
});
