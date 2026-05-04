import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import {
  createBacklogItem,
  claimNextBacklogItem,
  unlockBacklogItem,
} from '../../src/main/db/backlog';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-claim-'));
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

describe('claimNextBacklogItem', () => {
  it('returns null when nothing claimable', () => {
    expect(claimNextBacklogItem(repoId, 'bug', 'r1')).toBeNull();
  });

  it('two callers atomically pick different rows', () => {
    createBacklogItem({ repoId, source: 'manual', title: 'A', kind: 'bug', priorityLabel: 'P0' });
    createBacklogItem({ repoId, source: 'manual', title: 'B', kind: 'bug', priorityLabel: 'P0' });

    const a = claimNextBacklogItem(repoId, 'bug', 'r1');
    const b = claimNextBacklogItem(repoId, 'bug', 'r2');
    const c = claimNextBacklogItem(repoId, 'bug', 'r3');

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it('5 items + 10 callers = 5 unique winners, 5 nulls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const it = createBacklogItem({
        repoId,
        source: 'manual',
        title: `bug ${i}`,
        kind: 'bug',
      });
      ids.add(it.id);
    }
    const winners = new Set<string>();
    let nulls = 0;
    for (let i = 0; i < 10; i++) {
      const it = claimNextBacklogItem(repoId, 'bug', `runner-${i}`);
      if (it) winners.add(it.id);
      else nulls++;
    }
    expect(winners.size).toBe(5);
    expect(nulls).toBe(5);
    // Every winner came from the seeded set.
    for (const w of winners) expect(ids.has(w)).toBe(true);
  });

  it('release lets the next caller pick the released row', () => {
    const i = createBacklogItem({
      repoId,
      source: 'manual',
      title: 'only-bug',
      kind: 'bug',
    });
    const claim = claimNextBacklogItem(repoId, 'bug', 'r1');
    expect(claim?.id).toBe(i.id);
    expect(claimNextBacklogItem(repoId, 'bug', 'r2')).toBeNull();

    unlockBacklogItem(i.id);
    const recovered = claimNextBacklogItem(repoId, 'bug', 'r3');
    expect(recovered?.id).toBe(i.id);
  });

  it('respects kind — feature claim ignores bug rows', () => {
    createBacklogItem({ repoId, source: 'manual', title: 'b', kind: 'bug' });
    expect(claimNextBacklogItem(repoId, 'feature', 'r')).toBeNull();
  });
});
