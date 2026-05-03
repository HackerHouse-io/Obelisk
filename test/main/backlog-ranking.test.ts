import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import {
  createBacklogItem,
  listBacklog,
  nextAvailable,
  reorderBacklog,
  lockBacklogItem,
} from '../../src/main/db/backlog';
import { createRun } from '../../src/main/db/runs';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-rank-'));
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
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('backlog ranking', () => {
  it('orders by priority_label first (P0 > P1 > P2 > NULL)', () => {
    const a = createBacklogItem({ repoId, source: 'manual', title: 'A nopri', kind: 'bug' });
    const b = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'B P2',
      kind: 'bug',
      priorityLabel: 'P2',
    });
    const c = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'C P0',
      kind: 'bug',
      priorityLabel: 'P0',
    });
    const d = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'D P1',
      kind: 'bug',
      priorityLabel: 'P1',
    });
    const ordered = listBacklog(repoId).map((i) => i.id);
    expect(ordered).toEqual([c.id, d.id, b.id, a.id]);
  });

  it('user_pin_rank wins over priority_label', () => {
    const a = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'A P0',
      kind: 'bug',
      priorityLabel: 'P0',
    });
    const b = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'B P2 pinned',
      kind: 'bug',
      priorityLabel: 'P2',
    });
    // Pin B above A.
    reorderBacklog(repoId, [b.id, a.id]);
    const ordered = listBacklog(repoId).map((i) => i.id);
    expect(ordered[0]).toBe(b.id);
    expect(ordered[1]).toBe(a.id);
  });

  it('nextAvailable skips items with in_progress_run set', () => {
    const a = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'A',
      kind: 'bug',
      priorityLabel: 'P0',
    });
    const b = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'B',
      kind: 'bug',
      priorityLabel: 'P1',
    });
    // Lock A — nextAvailable should now return B.
    const run = createRun({
      repoId,
      agentName: 'bug-fixer',
      trigger: 'manual',
      taskRef: 'manual:test',
      runnerUsed: 'claude',
    });
    lockBacklogItem(a.id, run.id);
    const next = nextAvailable(repoId, 'bug');
    expect(next?.id).toBe(b.id);
  });

  it('nextAvailable filters by kind', () => {
    createBacklogItem({
      repoId,
      source: 'manual',
      title: 'feat A',
      kind: 'feature',
      priorityLabel: 'P0',
    });
    const bug = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'bug B',
      kind: 'bug',
      priorityLabel: 'P1',
    });
    expect(nextAvailable(repoId, 'bug')?.id).toBe(bug.id);
  });
});
