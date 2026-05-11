import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { publish } from '../../src/main/publisher';
import type { Repo } from '../../src/shared/types';

const createReview = vi.fn();
const createComment = vi.fn();

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => ({
    pulls: { createReview },
    issues: { createComment },
  })),
}));

vi.mock('../../src/main/auth/token-store', () => ({
  loadGitHubToken: vi.fn(async () => ({ login: 'calovera', token: 't' })),
  getAuthedLogin: vi.fn(async () => 'calovera'),
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-pub-self-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  createReview.mockReset();
  createComment.mockReset();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(): Repo {
  return createRepo({
    githubFullName: 'calovera/wealthlab',
    localPath: '/tmp/unused',
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  });
}

describe('publisher: review self-rejection fallback', () => {
  it('downgrades a 422 self-review rejection to an issue comment with the same body', async () => {
    const repo = makeRepo();
    // Mimic the @octokit/request RequestError shape (status + message).
    createReview.mockRejectedValue(
      Object.assign(
        new Error('Validation Failed: "Review Can not request changes on your own pull request"'),
        { status: 422 },
      ),
    );
    createComment.mockResolvedValue({ data: { id: 99, html_url: 'https://gh/p/1#c99' } });

    const result = await publish({
      repo,
      runId: 'r',
      agentName: 'pr-reviewer',
      plan: { kind: 'review', prNumber: 42, event: 'REQUEST_CHANGES', body: 'real review body' },
    });

    expect(createReview).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining('real review body'),
      }),
    );
    expect(createComment.mock.calls[0][0].body).toContain('**Verdict:** REQUEST_CHANGES');
    expect(result).toEqual(
      expect.objectContaining({ kind: 'comment', issueNumber: 42, commentId: 99 }),
    );
  });

  it('rethrows non-self-review 422 errors so they surface as publish failures', async () => {
    const repo = makeRepo();
    createReview.mockRejectedValue(
      Object.assign(new Error('Validation Failed: something else entirely'), { status: 422 }),
    );

    await expect(
      publish({
        repo,
        runId: 'r',
        agentName: 'pr-reviewer',
        plan: { kind: 'review', prNumber: 7, event: 'APPROVE', body: '...' },
      }),
    ).rejects.toThrow(/something else/);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('returns kind=review when the API accepts it', async () => {
    const repo = makeRepo();
    createReview.mockResolvedValue({ data: { id: 1234 } });

    const result = await publish({
      repo,
      runId: 'r',
      agentName: 'pr-reviewer',
      plan: { kind: 'review', prNumber: 8, event: 'COMMENT', body: 'fine' },
    });

    expect(result).toEqual({ kind: 'review', prNumber: 8, reviewId: 1234 });
    expect(createComment).not.toHaveBeenCalled();
  });
});
