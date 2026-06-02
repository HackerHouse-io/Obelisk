import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { createBacklogItem, listBacklog } from '../../src/main/db/backlog';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { bugFixerHandler } from '../../src/main/agents/bug-fixer';
import type { Repo } from '../../src/shared/types';

// Stub Octokit so selectTask's fetchIssueContext gets predictable issue data
// without touching the network. Each test rebinds `issuesGet` below.
const issuesGet = vi.fn();
const fakeGh = {
  issues: {
    get: issuesGet,
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    addAssignees: vi.fn().mockResolvedValue({ data: {} }),
    removeAssignees: vi.fn().mockResolvedValue({ data: {} }),
  },
};
vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

// `getAuthedLogin` is consulted by the cross-install guard. The label-gone
// guard must fire BEFORE that, so the value here doesn't matter — but the
// import path needs to resolve.
vi.mock('../../src/main/auth/token-store', () => ({
  getAuthedLogin: vi.fn(async () => 'obelisk-test-user'),
  getStoredToken: vi.fn(async () => null),
}));

let tmpRoot: string;
let repoPath: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-stale-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

  repoPath = join(tmpRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);

  issuesGet.mockReset();
  fakeGh.issues.addLabels.mockClear();
  fakeGh.issues.addAssignees.mockClear();
  fakeGh.issues.removeLabel.mockClear();
  fakeGh.issues.removeAssignees.mockClear();
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRepo(): Repo {
  return createRepo({
    githubFullName: 'test/stale',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
}

describe('bug-fixer selectTask: stale-issue guard', () => {
  it('skips a backlog row whose live issue no longer has obelisk:fix and drops it', async () => {
    const repo = makeRepo();
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    // Backlog row pointing at GitHub issue #42 — left over from a prior
    // Bug Fixer run that just opened a PR (publisher removed obelisk:fix
    // from the live issue but the local row hasn't been reaped yet).
    createBacklogItem({
      repoId: repo.id,
      source: 'gh_issue',
      githubIssue: 42,
      title: 'Stale row, PR already opened',
      kind: 'bug',
      priorityLabel: 'P1',
    });

    issuesGet.mockResolvedValue({
      data: {
        number: 42,
        state: 'open',
        locked: false,
        user: { login: 'fixture-author' },
        assignees: [],
        labels: [{ name: 'P1' }], // obelisk:fix is gone
      },
    });

    await expect(
      bugFixerHandler.selectTask({
        repo,
        defaultRunner: 'claude',
        trigger: 'manual',
      }),
    ).rejects.toMatchObject({
      code: 'BACKLOG_ALL_FILTERED',
      message: expect.stringContaining('no longer labeled `obelisk:fix`'),
    });

    // Row was dropped so the next Run-now click won't trip on it again.
    expect(listBacklog(repo.id)).toHaveLength(0);
  });

  it('still picks a row whose live issue keeps obelisk:fix (sanity check)', async () => {
    const repo = makeRepo();
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    createBacklogItem({
      repoId: repo.id,
      source: 'gh_issue',
      githubIssue: 99,
      title: 'Live issue, label still applied',
      kind: 'bug',
      priorityLabel: 'P0',
    });

    issuesGet.mockResolvedValue({
      data: {
        number: 99,
        state: 'open',
        locked: false,
        user: { login: 'fixture-author' },
        assignees: [],
        labels: [{ name: 'obelisk:fix' }, { name: 'P0' }],
      },
    });

    const selected = await bugFixerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'manual',
    });
    expect(selected).not.toBeNull();
    expect(selected?.task.ref).toBe('issue#99');
  });

  it('matches obelisk:fix case-insensitively (label normalization)', async () => {
    const repo = makeRepo();
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');

    createBacklogItem({
      repoId: repo.id,
      source: 'gh_issue',
      githubIssue: 7,
      title: 'Mixed-case label',
      kind: 'bug',
    });

    issuesGet.mockResolvedValue({
      data: {
        number: 7,
        state: 'open',
        locked: false,
        user: { login: 'fixture-author' },
        assignees: [],
        labels: [{ name: 'Obelisk:Fix' }],
      },
    });

    const selected = await bugFixerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'manual',
    });
    expect(selected?.task.ref).toBe('issue#7');
  });
});

describe('bug-fixer selectTask: cross-install ownership', () => {
  // The claim signature `postClaimSignal` writes (`obelisk:in-progress` +
  // self-assignee) is identical whether WE wrote it or a sibling install did.
  // Disambiguation hangs entirely on the per-install runs table.
  const claimedIssue = {
    number: 55,
    state: 'open',
    locked: false,
    user: { login: 'fixture-author' },
    assignees: [{ login: 'obelisk-test-user' }], // == mocked getAuthedLogin
    labels: [{ name: 'obelisk:fix' }, { name: 'obelisk:in-progress' }],
  };

  function seedClaimedRow(repo: Repo) {
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    createBacklogItem({
      repoId: repo.id,
      source: 'gh_issue',
      githubIssue: 55,
      title: 'Issue carrying our own in-progress signature',
      kind: 'bug',
      priorityLabel: 'P1',
    });
    issuesGet.mockResolvedValue({ data: claimedIssue });
  }

  it('self-heals our OWN leftover claim when a local run row exists for the issue', async () => {
    const repo = makeRepo();
    seedClaimedRow(repo);

    // A prior Bug Fixer run on issue#55 that finished (failed) but never got
    // its claim signal cleared — the exact orphan that used to lock the user
    // out for 24h behind "claimed by another Obelisk install".
    const prior = createRun({
      repoId: repo.id,
      agentName: 'bug-fixer',
      agentId: null,
      trigger: 'manual',
      taskRef: 'issue#55',
      runnerUsed: 'claude',
    });
    transitionRun(prior.id, 'failed');

    const selected = await bugFixerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'manual',
    });

    // Recovered: the issue is picked up instead of erroring, and the claim
    // signal is re-asserted (idempotent label + assignee).
    expect(selected?.task.ref).toBe('issue#55');
    expect(fakeGh.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 55, labels: ['obelisk:in-progress'] }),
    );
    expect(fakeGh.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 55, assignees: ['obelisk-test-user'] }),
    );
  });

  it('skips a genuinely foreign claim (same signature, NO local run row)', async () => {
    const repo = makeRepo();
    seedClaimedRow(repo);
    // No createRun → this install has never touched issue#55, so the signature
    // belongs to another install signed in as the same GitHub user.

    await expect(
      bugFixerHandler.selectTask({
        repo,
        defaultRunner: 'claude',
        trigger: 'manual',
      }),
    ).rejects.toMatchObject({
      code: 'BACKLOG_ALL_FILTERED',
      message: expect.stringContaining('already claimed by another Obelisk install'),
    });

    // No claim signal was written for a PR we don't own.
    expect(fakeGh.issues.addLabels).not.toHaveBeenCalled();
    expect(fakeGh.issues.addAssignees).not.toHaveBeenCalled();
  });
});
