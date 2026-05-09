import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import {
  upsertBacklogFromGithub,
  deleteBacklogGhIssue,
  listBacklog,
  claimNextBacklogItem,
  createBacklogItem,
} from '../../src/main/db/backlog';
import { derivePriority, deriveKind } from '../../src/main/scheduler/backlog-sync';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-sync-'));
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

describe('derivePriority', () => {
  it('matches plain P0/P1/P2', () => {
    expect(derivePriority(['P0'])).toBe('P0');
    expect(derivePriority(['P1'])).toBe('P1');
    expect(derivePriority(['P2'])).toBe('P2');
  });
  it('is case-insensitive', () => {
    expect(derivePriority(['p0'])).toBe('P0');
  });
  it('matches priority/p0 and priority:p0 patterns', () => {
    expect(derivePriority(['priority/p0'])).toBe('P0');
    expect(derivePriority(['priority:p1'])).toBe('P1');
  });
  it('returns null when no priority label present', () => {
    expect(derivePriority(['bug', 'help-wanted'])).toBeNull();
    expect(derivePriority([])).toBeNull();
  });
});

describe('deriveKind', () => {
  it('returns "bug" when obelisk:fix is the trigger label', () => {
    expect(deriveKind(['obelisk:fix'])).toBe('bug');
    expect(deriveKind(['P0', 'obelisk:fix', 'needs-triage'])).toBe('bug');
  });

  it('returns "feature" when obelisk:feature is the trigger label', () => {
    expect(deriveKind(['obelisk:feature'])).toBe('feature');
  });

  it('feature wins when both trigger labels are present (larger scope wins)', () => {
    expect(deriveKind(['obelisk:fix', 'obelisk:feature'])).toBe('feature');
  });

  it('returns null when neither trigger label is present — sync skips these issues', () => {
    expect(deriveKind([])).toBeNull();
    expect(deriveKind(['bug', 'P0', 'enhancement', 'feature'])).toBeNull();
    expect(deriveKind(['needs-triage'])).toBeNull();
  });
});

describe('listBacklogGhIssueNumbers', () => {
  it('returns only gh_issue rows, not manual rows', async () => {
    const { listBacklogGhIssueNumbers, createBacklogItem } = await import(
      '../../src/main/db/backlog'
    );
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 11,
      title: 'first',
      kind: 'bug',
      priorityLabel: null,
    });
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 22,
      title: 'second',
      kind: 'bug',
      priorityLabel: null,
    });
    createBacklogItem({
      repoId,
      source: 'manual',
      title: 'manual one',
      kind: 'bug',
    });
    expect(listBacklogGhIssueNumbers(repoId).sort()).toEqual([11, 22]);
  });

  it('returns an empty array for a repo with no gh_issue rows', async () => {
    const { listBacklogGhIssueNumbers } = await import('../../src/main/db/backlog');
    expect(listBacklogGhIssueNumbers(repoId)).toEqual([]);
  });
});

describe('upsertBacklogFromGithub', () => {
  it('inserts a new row on first call', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 42,
      title: 'fix: things',
      kind: 'bug',
      priorityLabel: 'P0',
    });
    const items = listBacklog(repoId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      githubIssue: 42,
      title: 'fix: things',
      kind: 'bug',
      priorityLabel: 'P0',
      source: 'gh_issue',
    });
  });

  it('updates title/priority/kind on second call without duplicating', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 42,
      title: 'first',
      kind: 'bug',
      priorityLabel: 'P2',
    });
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 42,
      title: 'second',
      kind: 'feature',
      priorityLabel: 'P0',
    });
    const items = listBacklog(repoId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      githubIssue: 42,
      title: 'second',
      kind: 'feature',
      priorityLabel: 'P0',
    });
  });

  it('partial unique index lets manual rows with the same number coexist', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 7,
      title: 'gh-row',
      kind: 'bug',
      priorityLabel: null,
    });
    // A manual row with no github_issue must not collide.
    expect(() =>
      createBacklogItem({
        repoId,
        source: 'manual',
        title: 'manual-row',
        kind: 'bug',
        priorityLabel: null,
      }),
    ).not.toThrow();
    expect(listBacklog(repoId)).toHaveLength(2);
  });

  it('preserves added_at across upserts so ranking by added_at is stable', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 1,
      title: 'a',
      kind: 'bug',
      priorityLabel: null,
    });
    const first = listBacklog(repoId)[0]!;
    // Mutate the title via a second upsert; added_at should still match.
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 1,
      title: 'a-renamed',
      kind: 'bug',
      priorityLabel: null,
    });
    const second = listBacklog(repoId)[0]!;
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('a-renamed');
  });
});

describe('deleteBacklogGhIssue', () => {
  it('drops a gh_issue row that is not in flight', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 9,
      title: 't',
      kind: 'bug',
      priorityLabel: null,
    });
    expect(listBacklog(repoId)).toHaveLength(1);
    deleteBacklogGhIssue(repoId, 9);
    expect(listBacklog(repoId)).toHaveLength(0);
  });

  it('refuses to delete a row currently locked by a run', () => {
    upsertBacklogFromGithub({
      repoId,
      githubIssue: 9,
      title: 't',
      kind: 'bug',
      priorityLabel: null,
    });
    claimNextBacklogItem(repoId, 'bug', 'pending:abc');
    deleteBacklogGhIssue(repoId, 9);
    // Still there because in_progress_run was non-null.
    expect(listBacklog(repoId)).toHaveLength(1);
  });

  it('is a no-op for an unknown issue number', () => {
    expect(() => deleteBacklogGhIssue(repoId, 12345)).not.toThrow();
  });
});
