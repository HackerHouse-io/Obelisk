import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun } from '../../src/main/db/runs';
import { getPreviewById } from '../../src/main/db/previews';
import {
  handlePreviewsCreateDraftFromCase,
  handlePreviewsFileIssue,
} from '../../src/main/ipc/previews';

const fakeGh = {
  issues: {
    create: vi.fn(),
  },
};

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let seedSeq = 0;

beforeEach(() => {
  seedSeq += 1;
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-previews-draft-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
  fakeGh.issues.create.mockReset();
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('previews:createDraftFromCase', () => {
  it('synthesizes a preview from a failed case the agent did not file', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const run = createRun({
      repoId: repo.id,
      agentName: 'qa-hunter',
      agentId: null,
      trigger: 'manual',
      taskRef: `plan:plan-${seedSeq}`,
      runnerUsed: 'claude',
    });

    const finding = await handlePreviewsCreateDraftFromCase({
      runId: run.id,
      caseId: '01H_CASE',
      caseTitle: 'Login redirects to /login on Safari with strict cookies',
      expected: 'User stays signed in.',
      repro: '1. Open Safari\n2. Sign in\n3. Wait 30s',
      severity: 'P1',
      failureDetail: 'redirects to /login instead of staying signed in',
    });

    expect(finding.title).toBe('[bug] Login redirects to /login on Safari with strict cookies');
    expect(finding.severity).toBe('P1');
    expect(finding.labels).toContain('obelisk:fix');
    expect(finding.labels).toContain('severity:P1');
    expect(finding.body).toContain('redirects to /login instead of staying signed in');
    expect(finding.body).toContain('User stays signed in.');
    expect(finding.body).toContain('<!-- obelisk:case_id=01H_CASE -->');
    expect(finding.published).toBeNull();
    expect(finding.dismissed).toBe(false);

    fakeGh.issues.create.mockResolvedValueOnce({
      data: { number: 73, html_url: 'https://github.com/test/x/issues/73' },
    });
    const published = await handlePreviewsFileIssue({
      previewId: finding.id,
      title: finding.title,
      body: finding.body,
      labels: finding.labels,
    });
    expect(published.issueNumber).toBe(73);
    expect(fakeGh.issues.create).toHaveBeenCalledTimes(1);

    const reread = getPreviewById(finding.id)!;
    expect(reread.finding.published?.issueNumber).toBe(73);
  });

  it('defaults severity to P2 when caller passes null', async () => {
    const repo = createRepo({
      githubFullName: 'test/y',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const run = createRun({
      repoId: repo.id,
      agentName: 'qa-hunter',
      agentId: null,
      trigger: 'manual',
      taskRef: `plan:plan-${seedSeq}`,
      runnerUsed: 'claude',
    });
    const finding = await handlePreviewsCreateDraftFromCase({
      runId: run.id,
      caseId: 'c1',
      caseTitle: 'A failing case',
      expected: null,
      repro: null,
      severity: null,
      failureDetail: null,
    });
    expect(finding.severity).toBe('P2');
    expect(finding.labels).toContain('severity:P2');
    expect(finding.body).toContain('did not file a finding');
    expect(finding.body).toContain('_(describe steps to reproduce');
  });

  it('rejects unknown runId with NOT_FOUND', async () => {
    await expect(
      handlePreviewsCreateDraftFromCase({
        runId: 'run-that-does-not-exist',
        caseId: 'c1',
        caseTitle: 'x',
        expected: null,
        repro: null,
        severity: null,
        failureDetail: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects empty caseId or caseTitle with INVALID_INPUT', async () => {
    const repo = createRepo({
      githubFullName: 'test/z',
      localPath: tmpRoot,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const run = createRun({
      repoId: repo.id,
      agentName: 'qa-hunter',
      agentId: null,
      trigger: 'manual',
      taskRef: `plan:plan-${seedSeq}`,
      runnerUsed: 'claude',
    });
    await expect(
      handlePreviewsCreateDraftFromCase({
        runId: run.id,
        caseId: '   ',
        caseTitle: 'x',
        expected: null,
        repro: null,
        severity: null,
        failureDetail: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      handlePreviewsCreateDraftFromCase({
        runId: run.id,
        caseId: 'c1',
        caseTitle: '',
        expected: null,
        repro: null,
        severity: null,
        failureDetail: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
