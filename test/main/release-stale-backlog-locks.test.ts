import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import {
  createBacklogItem,
  listBacklog,
  releaseStaleBacklogLocks,
} from '../../src/main/db/backlog';
import { createRun, transitionRun } from '../../src/main/db/runs';

let tmp: string;
let repoId: string;
let agentId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-stale-locks-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
  agentId = createAgent({ repoId, name: 'bug-fixer', enabled: true }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Helper that mutates a backlog row's lock + last_seen_at directly,
 * bypassing the normal claim path. Lets us simulate the orphan
 * shapes the cleanup is supposed to handle without contorting the
 * setup through real run lifecycles.
 */
function setLock(backlogId: string, token: string | null, lastSeenAt: string): void {
  getDb()
    .prepare('UPDATE backlog SET in_progress_run = ?, last_seen_at = ? WHERE id = ?')
    .run(token, lastSeenAt, backlogId);
}

function addBug(title: string): string {
  return createBacklogItem({ repoId, source: 'manual', title, kind: 'bug' }).id;
}

describe('releaseStaleBacklogLocks', () => {
  it('clears locks pointing at terminal run ids (done / failed / cancelled)', () => {
    const aId = addBug('a');
    const bId = addBug('b');
    const cId = addBug('c');

    const runDone = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#a',
      runnerUsed: 'claude',
    });
    const runFailed = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#b',
      runnerUsed: 'claude',
    });
    const runCancelled = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#c',
      runnerUsed: 'claude',
    });
    transitionRun(runDone.id, 'done');
    transitionRun(runFailed.id, 'failed');
    transitionRun(runCancelled.id, 'cancelled');

    setLock(aId, runDone.id, new Date().toISOString());
    setLock(bId, runFailed.id, new Date().toISOString());
    setLock(cId, runCancelled.id, new Date().toISOString());

    expect(releaseStaleBacklogLocks(repoId)).toBe(3);
    const after = listBacklog(repoId);
    expect(after.find((b) => b.id === aId)?.inProgressRun).toBeNull();
    expect(after.find((b) => b.id === bId)?.inProgressRun).toBeNull();
    expect(after.find((b) => b.id === cId)?.inProgressRun).toBeNull();
  });

  it('preserves locks pointing at live run ids (queued / running / publishing / paused)', () => {
    const aId = addBug('queued bug');
    const bId = addBug('running bug');

    const queued = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#a',
      runnerUsed: 'claude',
    });
    const running = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#b',
      runnerUsed: 'claude',
    });
    transitionRun(running.id, 'running');

    setLock(aId, queued.id, new Date().toISOString());
    setLock(bId, running.id, new Date().toISOString());

    expect(releaseStaleBacklogLocks(repoId)).toBe(0);
    const after = listBacklog(repoId);
    expect(after.find((b) => b.id === aId)?.inProgressRun).toBe(queued.id);
    expect(after.find((b) => b.id === bId)?.inProgressRun).toBe(running.id);
  });

  it('clears locks pointing at run ids that no longer exist (process crash)', () => {
    const id = addBug('orphan');
    setLock(id, '01HZZZZZZZZZZZZZZZZZZZZZZZ', new Date().toISOString());

    expect(releaseStaleBacklogLocks(repoId)).toBe(1);
    expect(listBacklog(repoId)[0]?.inProgressRun).toBeNull();
  });

  it('clears placeholder pending:* tokens older than 60s', () => {
    const id = addBug('abandoned placeholder');
    const ancient = new Date(Date.now() - 5 * 60_000).toISOString();
    setLock(id, 'pending:01ABANDONED', ancient);

    expect(releaseStaleBacklogLocks(repoId)).toBe(1);
    expect(listBacklog(repoId)[0]?.inProgressRun).toBeNull();
  });

  it('preserves fresh placeholder pending:* tokens (selectTask in flight)', () => {
    const id = addBug('in-flight placeholder');
    setLock(id, 'pending:01FRESH', new Date().toISOString());

    expect(releaseStaleBacklogLocks(repoId)).toBe(0);
    expect(listBacklog(repoId)[0]?.inProgressRun).toBe('pending:01FRESH');
  });

  it('is scoped to the given repo — does not touch other repos', () => {
    const otherRepo = createRepo({
      githubFullName: 'test/y',
      localPath: join(tmp, 'other'),
      defaultBranch: 'main',
      mode: 'prs',
      defaultRunner: 'claude',
    });
    const otherAgent = createAgent({ repoId: otherRepo.id, name: 'bug-fixer', enabled: true });
    const myBug = addBug('mine');
    const otherBug = createBacklogItem({
      repoId: otherRepo.id,
      source: 'manual',
      title: 'theirs',
      kind: 'bug',
    });

    const myDone = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId,
      trigger: 'manual',
      taskRef: 'backlog#mine',
      runnerUsed: 'claude',
    });
    const theirDone = createRun({
      repoId: otherRepo.id,
      agentName: 'bug-fixer',
      agentId: otherAgent.id,
      trigger: 'manual',
      taskRef: 'backlog#theirs',
      runnerUsed: 'claude',
    });
    transitionRun(myDone.id, 'done');
    transitionRun(theirDone.id, 'done');

    setLock(myBug, myDone.id, new Date().toISOString());
    setLock(otherBug.id, theirDone.id, new Date().toISOString());

    expect(releaseStaleBacklogLocks(repoId)).toBe(1);
    // Other repo's stale lock is untouched.
    const otherAfter = getDb()
      .prepare<[string], { in_progress_run: string | null }>(
        'SELECT in_progress_run FROM backlog WHERE id = ?',
      )
      .get(otherBug.id);
    expect(otherAfter?.in_progress_run).toBe(theirDone.id);
  });
});
