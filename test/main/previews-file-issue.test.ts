import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun } from '../../src/main/db/runs';
import {
  getPreviewById,
  insertPreview,
  listPreviewsForRepo,
  markPreviewDismissed,
  markPreviewPublished,
} from '../../src/main/db/previews';
import { recordArtifact } from '../../src/main/db/evidence';
import {
  handlePreviewsFileIssue,
  handlePreviewsDismiss,
  handlePreviewsGet,
} from '../../src/main/ipc/previews';

const fakeGh = {
  issues: {
    create: vi.fn(),
    createComment: vi.fn().mockResolvedValue({
      data: { id: 1, html_url: 'https://example.test/c' },
    }),
  },
  pulls: {
    create: vi.fn(),
    createReview: vi.fn(),
  },
};

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;

let seedSeq = 0;
function seedPreview(opts: {
  repoId: string;
  agentName: 'qa-hunter' | 'manual-qa' | 'ios-qa-pilot';
  title: string;
  body: string;
  labels: string[];
}): { previewId: number; runId: string } {
  // Each preview needs a fresh run row (per-task-ref single-flight requires
  // distinct taskRefs across in-flight runs).
  seedSeq += 1;
  const run = createRun({
    repoId: opts.repoId,
    agentName: opts.agentName,
    agentId: null,
    trigger: 'manual',
    taskRef: `qa-sweep-${seedSeq}`,
    runnerUsed: 'claude',
  });
  const previewId = insertPreview({
    repoId: opts.repoId,
    runId: run.id,
    agentName: opts.agentName,
    payload: { kind: 'issue', title: opts.title, body: opts.body, labels: opts.labels },
  });
  return { previewId, runId: run.id };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-previews-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
  fakeGh.issues.create.mockReset();
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('previews file-issue manual flow', () => {
  it('publishes a previewed finding even when the repo is in observe mode', async () => {
    const repo = createRepo({
      githubFullName: 'test/observe-repo',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId } = seedPreview({
      repoId: repo.id,
      agentName: 'qa-hunter',
      title: 'Race in session refresh',
      body: '## Symptom\nSession reissue fails on Safari.',
      labels: ['bug', 'severity:P0'],
    });

    fakeGh.issues.create.mockResolvedValueOnce({
      data: { number: 42, html_url: 'https://github.com/test/observe-repo/issues/42' },
    });

    const res = await handlePreviewsFileIssue({
      previewId,
      title: 'Race in session refresh (edited)',
      body: '## Symptom\nSession reissue fails on Safari.',
      labels: ['bug', 'severity:P0'],
    });

    expect(res.issueNumber).toBe(42);
    expect(res.htmlUrl).toBe('https://github.com/test/observe-repo/issues/42');
    expect(fakeGh.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Race in session refresh (edited)',
        labels: ['bug', 'severity:P0'],
      }),
    );

    // The published-state lookup should now find the marker.
    const after = getPreviewById(previewId)!;
    expect(after.finding.published).toEqual(
      expect.objectContaining({
        issueNumber: 42,
        htmlUrl: 'https://github.com/test/observe-repo/issues/42',
      }),
    );
  });

  it('rejects re-publishing a preview that has already been published', async () => {
    const repo = createRepo({
      githubFullName: 'test/observe-repo',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId, runId } = seedPreview({
      repoId: repo.id,
      agentName: 'manual-qa',
      title: 'Login flow flake',
      body: 'flaky',
      labels: ['bug'],
    });
    markPreviewPublished({
      sourcePreviewId: previewId,
      runId,
      issueNumber: 7,
      htmlUrl: 'https://github.com/test/observe-repo/issues/7',
    });

    await expect(
      handlePreviewsFileIssue({
        previewId,
        title: 'Login flow flake',
        body: 'flaky',
        labels: ['bug'],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fakeGh.issues.create).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for unknown previews', async () => {
    await expect(
      handlePreviewsFileIssue({
        previewId: 99999,
        title: 'x',
        body: 'y',
        labels: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an empty title', async () => {
    const repo = createRepo({
      githubFullName: 'test/observe-repo',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId } = seedPreview({
      repoId: repo.id,
      agentName: 'qa-hunter',
      title: 'A',
      body: 'b',
      labels: [],
    });
    await expect(
      handlePreviewsFileIssue({ previewId, title: '   ', body: 'b', labels: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('previews list enrichment', () => {
  it('attaches severity from labels, evidence from artifacts, and published state', async () => {
    const repo = createRepo({
      githubFullName: 'test/r',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId, runId } = seedPreview({
      repoId: repo.id,
      agentName: 'ios-qa-pilot',
      title: 'Login spinner hangs',
      body: 'symptom',
      labels: ['bug', 'severity:P1', 'flow:login'],
    });
    recordArtifact({
      runId,
      kind: 'screenshot',
      path: '/tmp/r/sshot.png',
      bytes: 1234,
      sha256: 'abc',
    });
    recordArtifact({
      runId,
      kind: 'recording',
      path: '/tmp/r/rec.mp4',
      bytes: 99000,
      sha256: 'def',
    });
    recordArtifact({
      runId,
      kind: 'patch',
      path: '/tmp/r/p.diff',
      bytes: 100,
      sha256: 'xyz',
    });
    markPreviewPublished({
      sourcePreviewId: previewId,
      runId,
      issueNumber: 11,
      htmlUrl: 'https://example.test/issues/11',
    });

    const list = listPreviewsForRepo(repo.id);
    expect(list).toHaveLength(1);
    const f = list[0]!;
    expect(f.severity).toBe('P1');
    expect(f.evidence.map((e) => e.kind).sort()).toEqual(['recording', 'screenshot']);
    expect(f.published).toEqual(
      expect.objectContaining({ issueNumber: 11, htmlUrl: 'https://example.test/issues/11' }),
    );
    expect(f.dismissed).toBe(false);
  });

  it('marks dismissed previews so the UI can hide them', async () => {
    const repo = createRepo({
      githubFullName: 'test/r',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId, runId } = seedPreview({
      repoId: repo.id,
      agentName: 'qa-hunter',
      title: 'False positive',
      body: 'b',
      labels: [],
    });
    markPreviewDismissed({ sourcePreviewId: previewId, runId });

    const f = (await handlePreviewsGet({ previewId })) ?? null;
    expect(f).not.toBeNull();
    expect(f!.dismissed).toBe(true);
  });

  it('previews:dismiss IPC marks the row as dismissed', async () => {
    const repo = createRepo({
      githubFullName: 'test/r',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const { previewId } = seedPreview({
      repoId: repo.id,
      agentName: 'qa-hunter',
      title: 'q',
      body: 'b',
      labels: [],
    });
    const res = await handlePreviewsDismiss({ previewId });
    expect(res.ok).toBe(true);
    const found = await handlePreviewsGet({ previewId });
    expect(found.dismissed).toBe(true);
  });
});
