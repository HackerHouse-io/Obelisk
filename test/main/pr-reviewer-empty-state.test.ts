import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { prReviewerHandler } from '../../src/main/agents/pr-reviewer';
import { ulid } from 'ulid';
import { ObeliskError } from '../../src/shared/errors';
import type { Repo } from '../../src/shared/types';

// Mock Octokit at the module boundary (mirrors pr-reviewer-auto-fix.test.ts).
const pullsList = vi.fn();
const pullsGet = vi.fn();
const fakeGh = {
  pulls: { list: pullsList, get: pullsGet },
  issues: {
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    addAssignees: vi.fn().mockResolvedValue({ data: {} }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    removeAssignees: vi.fn().mockResolvedValue({ data: {} }),
  },
};
vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

const CONNECTED_USER = 'obelisk-test-user';
vi.mock('../../src/main/auth/token-store', () => ({
  loadGitHubToken: vi.fn(async () => ({ login: CONNECTED_USER, token: 't' })),
  getAuthedLogin: vi.fn(async () => CONNECTED_USER),
  getStoredToken: vi.fn(async () => null),
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-prr-empty-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  pullsList.mockReset();
  pullsGet.mockReset();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(): Repo {
  return createRepo({
    githubFullName: 'test/empty-state',
    localPath: '/tmp/unused-for-selecttask-tests',
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  });
}

function makeAgent(repoId: string): string {
  return createAgent({ repoId, name: 'pr-reviewer' }).id;
}

function mockPr(input: { number: number; author?: string; headSha?: string }) {
  return {
    number: input.number,
    title: `PR #${input.number}`,
    body: 'A pull request.',
    user: { login: input.author ?? CONNECTED_USER },
    head: {
      ref: `feature/${input.number}`,
      sha: input.headSha ?? `sha-${input.number}-aaaaaaaaaaaa`,
    },
    labels: [],
    assignees: [],
  };
}

/** Seed a completed pr-reviewer run so `alreadyReviewed` counts this (PR, SHA). */
function seedReviewedRun(repoId: string, prNumber: number, headSha: string): void {
  const taskRef = `pr#${prNumber}@${headSha.slice(0, 12)}`;
  getDb()
    .prepare(
      `INSERT INTO runs (id, repo_id, agent_name, agent_id, trigger, task_ref,
                         task_context, runner_used, state, started_at)
       VALUES (?, ?, 'pr-reviewer', NULL, 'schedule', ?, NULL, 'claude', 'done', ?)`,
    )
    .run(ulid(), repoId, taskRef, new Date().toISOString());
}

describe('pr-reviewer selectTask: explicit empty-state reasons', () => {
  it('throws NO_OPEN_PRS on a manual run when there are no open PRs', async () => {
    const repo = makeRepo();
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({ data: [] });

    await expect(
      prReviewerHandler.selectTask({ repo, defaultRunner: 'claude', trigger: 'manual', agentId }),
    ).rejects.toMatchObject({ code: 'NO_OPEN_PRS' });
  });

  it('stays quiet (returns null) on a scheduled sweep with no open PRs', async () => {
    const repo = makeRepo();
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({ data: [] });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });
    expect(selected).toBeNull();
  });

  it('throws PRS_ALL_FILTERED naming "already reviewed" when every PR is reviewed at its head', async () => {
    const repo = makeRepo();
    const agentId = makeAgent(repo.id);
    const sha = 'sha99aaaaaaaaaa';
    pullsList.mockResolvedValue({ data: [mockPr({ number: 99, headSha: sha })] });
    seedReviewedRun(repo.id, 99, sha);

    const err = await prReviewerHandler
      .selectTask({ repo, defaultRunner: 'claude', trigger: 'manual', agentId })
      .then(() => null)
      .catch((e) => e as ObeliskError);

    expect(err).toBeInstanceOf(ObeliskError);
    expect(err!.code).toBe('PRS_ALL_FILTERED');
    expect(err!.message).toContain('already reviewed at the latest commit');
  });

  it('throws PRS_ALL_FILTERED with the allowlist hint when all PRs are from non-allowlisted authors', async () => {
    const repo = makeRepo();
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [mockPr({ number: 7, author: 'random-contributor' })],
    });

    const err = await prReviewerHandler
      .selectTask({ repo, defaultRunner: 'claude', trigger: 'manual', agentId })
      .then(() => null)
      .catch((e) => e as ObeliskError);

    expect(err).toBeInstanceOf(ObeliskError);
    expect(err!.code).toBe('PRS_ALL_FILTERED');
    expect(err!.message).toContain('not on the allowlist');
    expect(err!.hint).toBe('Add the PR authors via the Allowlist settings.');
  });

  it('stays quiet (returns null) on a scheduled sweep when all PRs are filtered', async () => {
    const repo = makeRepo();
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [mockPr({ number: 7, author: 'random-contributor' })],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });
    expect(selected).toBeNull();
  });
});
