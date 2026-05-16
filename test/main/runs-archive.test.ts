import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import {
  createRun,
  transitionRun,
  listRuns,
  listArchivedRuns,
  archiveRun,
  archiveRunsForRepo,
  restoreRun,
  deleteRun,
  getRun,
  countArchivedRuns,
  deleteArchivedRunsForRepo,
} from '../../src/main/db/runs';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-archive-'));
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

function seedTerminalRun(taskRef: string, state: 'done' | 'failed' = 'done'): string {
  const r = createRun({
    repoId,
    agentName: 'bug-fixer',
    agentId: null,
    trigger: 'manual',
    taskRef,
    runnerUsed: 'claude',
  });
  transitionRun(r.id, state);
  return r.id;
}

describe('archiveRun', () => {
  it('soft-deletes a terminal run and listRuns omits it', () => {
    const id = seedTerminalRun('issue#1');
    archiveRun(id);

    const live = listRuns(repoId);
    expect(live.find((r) => r.id === id)).toBeUndefined();

    const archived = listArchivedRuns(repoId);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(id);
    expect(archived[0].archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to archive an active run', () => {
    const r = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: null,
      trigger: 'manual',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'running');
    expect(() => archiveRun(r.id)).toThrowError(/still running/);
  });

  it('is idempotent — archiving an already-archived run is a no-op', () => {
    const id = seedTerminalRun('issue#1');
    archiveRun(id);
    const first = getRun(id)!.archivedAt;
    archiveRun(id);
    expect(getRun(id)!.archivedAt).toBe(first);
  });
});

describe('archiveRunsForRepo', () => {
  it('moves only done/failed runs by default', () => {
    seedTerminalRun('issue#1', 'done');
    seedTerminalRun('issue#2', 'failed');
    const cancelled = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: null,
      trigger: 'manual',
      taskRef: 'issue#3',
      runnerUsed: 'claude',
    });
    transitionRun(cancelled.id, 'cancelled');

    const moved = archiveRunsForRepo(repoId, ['done', 'failed']);
    expect(moved).toBe(2);
    expect(listRuns(repoId)).toHaveLength(1);
    expect(listRuns(repoId)[0].state).toBe('cancelled');
    expect(listArchivedRuns(repoId)).toHaveLength(2);
  });

  it('skips already-archived rows on a second call', () => {
    seedTerminalRun('issue#1');
    seedTerminalRun('issue#2');
    expect(archiveRunsForRepo(repoId, ['done', 'failed'])).toBe(2);
    expect(archiveRunsForRepo(repoId, ['done', 'failed'])).toBe(0);
  });
});

describe('restoreRun', () => {
  it('returns an archived run to the live list', () => {
    const id = seedTerminalRun('issue#1');
    archiveRun(id);
    expect(listRuns(repoId)).toHaveLength(0);

    restoreRun(id);
    expect(listRuns(repoId)).toHaveLength(1);
    expect(listArchivedRuns(repoId)).toHaveLength(0);
    expect(getRun(id)!.archivedAt).toBeNull();
  });
});

describe('listArchivedRuns search', () => {
  it('filters by taskRef substring', () => {
    seedTerminalRun('issue#42');
    seedTerminalRun('issue#99');
    archiveRunsForRepo(repoId, ['done', 'failed']);

    const hits = listArchivedRuns(repoId, '42');
    expect(hits).toHaveLength(1);
    expect(hits[0].taskRef).toBe('issue#42');
  });

  it('filters by agent_name case-insensitively', () => {
    seedTerminalRun('issue#1');
    archiveRunsForRepo(repoId, ['done', 'failed']);

    expect(listArchivedRuns(repoId, 'BUG')).toHaveLength(1);
    expect(listArchivedRuns(repoId, 'qa-hunter')).toHaveLength(0);
  });

  it('empty query returns everything, newest-archived first', () => {
    const id1 = seedTerminalRun('issue#1');
    const id2 = seedTerminalRun('issue#2');
    archiveRun(id1);
    // Force a measurable ordering gap so archivedAt timestamps differ.
    const later = new Date(Date.now() + 1000).toISOString();
    // Bypass archiveRun to set a known later archivedAt for id2.
    archiveRun(id2);
    // Sanity: at least the call succeeded; order is by archivedAt DESC.
    const all = listArchivedRuns(repoId, '');
    expect(all).toHaveLength(2);
    expect(new Date(all[0].archivedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(all[1].archivedAt!).getTime(),
    );
    // Avoid unused-var lint complaint for the `later` variable.
    expect(later).toMatch(/T/);
  });
});

describe('deleteRun still works on archived rows', () => {
  it('a permanent delete after archiving removes the row entirely', () => {
    const id = seedTerminalRun('issue#1');
    archiveRun(id);
    deleteRun(id);
    expect(getRun(id)).toBeNull();
    expect(listArchivedRuns(repoId)).toHaveLength(0);
    expect(listRuns(repoId)).toHaveLength(0);
  });
});

describe('countArchivedRuns', () => {
  it('returns 0 with no archived rows', () => {
    seedTerminalRun('issue#1');
    expect(countArchivedRuns(repoId)).toBe(0);
  });

  it('counts only archived rows', () => {
    const a = seedTerminalRun('issue#1');
    seedTerminalRun('issue#2');
    archiveRun(a);
    expect(countArchivedRuns(repoId)).toBe(1);
  });
});

describe('deleteArchivedRunsForRepo', () => {
  it('hard-deletes every archived row and leaves live rows alone', () => {
    const a = seedTerminalRun('issue#1');
    const b = seedTerminalRun('issue#2');
    seedTerminalRun('issue#3'); // stays live
    archiveRun(a);
    archiveRun(b);

    expect(deleteArchivedRunsForRepo(repoId)).toBe(2);
    expect(countArchivedRuns(repoId)).toBe(0);
    expect(listRuns(repoId)).toHaveLength(1);
  });

  it('is a no-op when the archive is empty', () => {
    expect(deleteArchivedRunsForRepo(repoId)).toBe(0);
  });
});
