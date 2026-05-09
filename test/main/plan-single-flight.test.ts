import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, getActiveRunForTaskRef, transitionRun } from '../../src/main/db/runs';
import { ObeliskError } from '../../src/shared/errors';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-singleflight-'));
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

describe('per-task-ref single-flight in createRun', () => {
  it('two runs against the SAME plan are blocked — second throws RUN_ACTIVE', () => {
    const a1 = createAgent({ repoId, name: 'qa-hunter' });
    const a2 = createAgent({ repoId, name: 'qa-hunter' });
    const taskRef = 'plan:01H_FULL_APP_SWEEP';

    const first = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a1.id,
      trigger: 'manual',
      taskRef,
      runnerUsed: 'claude',
    });
    expect(first.taskRef).toBe(taskRef);

    expect(() =>
      createRun({
        repoId,
        agentName: 'qa-hunter',
        agentId: a2.id,
        trigger: 'manual',
        taskRef,
        runnerUsed: 'claude',
      }),
    ).toThrow(ObeliskError);

    try {
      createRun({
        repoId,
        agentName: 'qa-hunter',
        agentId: a2.id,
        trigger: 'manual',
        taskRef,
        runnerUsed: 'claude',
      });
    } catch (e) {
      expect((e as ObeliskError).code).toBe('RUN_ACTIVE');
      expect((e as ObeliskError).hint).toMatch(/Mission Control/i);
    }
  });

  it('two runs against DIFFERENT plans both succeed (the multi-instance use case)', () => {
    const a1 = createAgent({ repoId, name: 'qa-hunter' });
    const a2 = createAgent({ repoId, name: 'qa-hunter' });

    const checkout = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a1.id,
      trigger: 'schedule',
      taskRef: 'plan:CHECKOUT',
      runnerUsed: 'claude',
    });
    const onboarding = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a2.id,
      trigger: 'schedule',
      taskRef: 'plan:ONBOARDING',
      runnerUsed: 'claude',
    });

    expect(checkout.id).not.toBe(onboarding.id);
    expect(checkout.taskRef).toBe('plan:CHECKOUT');
    expect(onboarding.taskRef).toBe('plan:ONBOARDING');
  });

  it('after the first run terminates, the same plan can be run again', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const taskRef = 'plan:RECURRING';

    const r1 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'schedule',
      taskRef,
      runnerUsed: 'claude',
    });
    transitionRun(r1.id, 'done', { outputSummary: 'ok' });

    // Same plan can be picked up again now that r1 is in a terminal state.
    const r2 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'schedule',
      taskRef,
      runnerUsed: 'claude',
    });
    expect(r2.id).not.toBe(r1.id);
  });

  it('a paused run still holds the lock (paused is not terminal)', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const taskRef = 'plan:PAUSED';

    const r1 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef,
      runnerUsed: 'claude',
    });
    transitionRun(r1.id, 'paused');

    expect(() =>
      createRun({
        repoId,
        agentName: 'qa-hunter',
        agentId: a.id,
        trigger: 'manual',
        taskRef,
        runnerUsed: 'claude',
      }),
    ).toThrow(/RUN_ACTIVE|already working/i);
  });

  it('different repos with the same plan id are independent', () => {
    const otherRepo = createRepo({
      githubFullName: 'test/y',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const a1 = createAgent({ repoId, name: 'qa-hunter' });
    const a2 = createAgent({ repoId: otherRepo.id, name: 'qa-hunter' });

    createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a1.id,
      trigger: 'schedule',
      taskRef: 'plan:OVERLAP',
      runnerUsed: 'claude',
    });
    // Same task_ref but different repo — should NOT collide.
    const r2 = createRun({
      repoId: otherRepo.id,
      agentName: 'qa-hunter',
      agentId: a2.id,
      trigger: 'schedule',
      taskRef: 'plan:OVERLAP',
      runnerUsed: 'claude',
    });
    expect(r2.taskRef).toBe('plan:OVERLAP');
  });

  it('null task_ref is never blocked (nothing-to-do paths still work)', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const r1 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: null,
      runnerUsed: 'claude',
    });
    const r2 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef: null,
      runnerUsed: 'claude',
    });
    expect(r1.id).not.toBe(r2.id);
  });

  it('getActiveRunForTaskRef finds a live run and returns null after it terminates', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const taskRef = 'plan:ACTIVE_PROBE';
    expect(getActiveRunForTaskRef(repoId, taskRef)).toBeNull();

    const r = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: a.id,
      trigger: 'manual',
      taskRef,
      runnerUsed: 'claude',
    });
    expect(getActiveRunForTaskRef(repoId, taskRef)?.id).toBe(r.id);

    transitionRun(r.id, 'failed', { errorCode: 'INTERNAL' });
    expect(getActiveRunForTaskRef(repoId, taskRef)).toBeNull();
  });
});
