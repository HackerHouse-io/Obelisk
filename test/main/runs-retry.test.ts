import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { createAgent } from '../../src/main/db/agents';
import { handleRunsRetry } from '../../src/main/ipc/runs';

let tmp: string;
let repoId: string;
let agentId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-retry-'));
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
    name: 'pr-reviewer',
    displayName: 'PR Reviewer',
    runnerOverride: null,
    scheduleCron: null,
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('handleRunsRetry validation', () => {
  it('rejects an unknown run', async () => {
    await expect(handleRunsRetry({ runId: 'nope' })).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('rejects a still-active run', async () => {
    const r = createRun({
      repoId,
      agentName: 'pr-reviewer',
      agentId: null,
      trigger: 'manual',
      taskRef: 'pr#1@abc',
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'running');
    await expect(handleRunsRetry({ runId: r.id })).rejects.toMatchObject({ code: 'RUN_ACTIVE' });
  });

  it('rejects a run not linked to an agent instance', async () => {
    const r = createRun({
      repoId,
      agentName: 'pr-reviewer',
      agentId: null,
      trigger: 'manual',
      taskRef: 'pr#1@abc',
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'failed');
    await expect(handleRunsRetry({ runId: r.id })).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  it('rejects a run with no task ref', async () => {
    const r = createRun({
      repoId,
      agentName: 'pr-reviewer',
      agentId,
      trigger: 'manual',
      taskRef: null,
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'failed');
    await expect(handleRunsRetry({ runId: r.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
