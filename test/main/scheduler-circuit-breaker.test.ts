import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent, getAgent } from '../../src/main/db/agents';
import { createRun, getRecentScheduledRunsForAgent, transitionRun } from '../../src/main/db/runs';
import { shouldOpenCircuitBreaker } from '../../src/main/scheduler/tick';
import type { Agent } from '../../src/shared/types';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-circuit-'));
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

/**
 * `transitionRun` always stamps `finished_at` to "now". For circuit-breaker
 * tests we need historical timestamps, so we patch the row after.
 */
function setFinishedAt(runId: string, when: Date): void {
  getDb().prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(when.toISOString(), runId);
}

function makeFailedScheduledRun(agentId: string, finishedAt: Date): void {
  const run = createRun({
    repoId,
    agentName: 'qa-hunter',
    agentId,
    trigger: 'schedule',
    taskRef: 'plan:x',
    runnerUsed: 'claude',
  });
  transitionRun(run.id, 'failed', {
    errorCode: 'INTERNAL',
    outputSummary: 'claude exited 1',
  });
  setFinishedAt(run.id, finishedAt);
}

function makeDoneScheduledRun(agentId: string, finishedAt: Date): void {
  const run = createRun({
    repoId,
    agentName: 'qa-hunter',
    agentId,
    trigger: 'schedule',
    taskRef: 'plan:x',
    runnerUsed: 'claude',
  });
  transitionRun(run.id, 'done', { outputSummary: 'ok' });
  setFinishedAt(run.id, finishedAt);
}

describe('scheduler circuit breaker', () => {
  it('getRecentScheduledRunsForAgent returns newest first, scheduled-only', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = Date.now();
    makeFailedScheduledRun(agent.id, new Date(now - 30_000));
    makeDoneScheduledRun(agent.id, new Date(now - 60_000));
    makeFailedScheduledRun(agent.id, new Date(now - 120_000));
    // A manual run shouldn't appear in the scheduled-only window.
    const manual = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: null,
      runnerUsed: 'claude',
    });
    transitionRun(manual.id, 'failed', { errorCode: 'INTERNAL' });
    setFinishedAt(manual.id, new Date(now));

    const recent = getRecentScheduledRunsForAgent(agent.id, 5);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.state).toBe('failed');
    expect(recent[1]!.state).toBe('done');
    expect(recent[2]!.state).toBe('failed');
  });

  it('does not trip with fewer than 3 failures', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = new Date();
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 60_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 30_000));
    expect(shouldOpenCircuitBreaker(getAgent(agent.id) as Agent, now)).toBe(false);
  });

  it('trips when the last 3 scheduled runs are all failed within the hour', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = new Date();
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 600_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 120_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 60_000));
    expect(shouldOpenCircuitBreaker(getAgent(agent.id) as Agent, now)).toBe(true);
  });

  it('does NOT trip when a success interleaves with failures', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = new Date();
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 600_000));
    makeDoneScheduledRun(agent.id, new Date(now.getTime() - 120_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - 60_000));
    expect(shouldOpenCircuitBreaker(getAgent(agent.id) as Agent, now)).toBe(false);
  });

  it('does NOT trip when failures are older than the window', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = new Date();
    // All three older than 1 hour.
    const beyond = 60 * 60 * 1000 + 60_000;
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - beyond - 30_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - beyond - 20_000));
    makeFailedScheduledRun(agent.id, new Date(now.getTime() - beyond - 10_000));
    expect(shouldOpenCircuitBreaker(getAgent(agent.id) as Agent, now)).toBe(false);
  });

  it('manual failures are ignored (only scheduled count toward the breaker)', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const now = new Date();
    // Three manual failures.
    for (let i = 0; i < 3; i++) {
      const run = createRun({
        repoId,
        agentName: 'qa-hunter',
        agentId: agent.id,
        trigger: 'manual',
        taskRef: null,
        runnerUsed: 'claude',
      });
      transitionRun(run.id, 'failed', { errorCode: 'INTERNAL' });
      setFinishedAt(run.id, new Date(now.getTime() - 60_000 * (i + 1)));
    }
    expect(shouldOpenCircuitBreaker(getAgent(agent.id) as Agent, now)).toBe(false);
  });
});
