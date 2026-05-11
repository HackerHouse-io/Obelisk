import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import {
  insertPreview,
  listPreviewsForRepo,
  listPublishedOpenPreviewIssueNumbersForRepo,
  markPreviewDismissed,
  markPreviewPublished,
} from '../../src/main/db/previews';

/**
 * The Command Center's "Task previews" card hides findings whose GitHub
 * issue has been closed. The backlog-sync sweep calls
 * `listPublishedOpenPreviewIssueNumbersForRepo` to know WHICH issue numbers
 * to recheck, then auto-dismisses the closed ones via `markPreviewDismissed`.
 * These tests pin the SQL contract so the sweep's input + output stay
 * correct as the schema evolves.
 */

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-preview-close-'));
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

let taskRefSeq = 0;
function makePublishedPreview(opts: {
  title: string;
  issueNumber: number;
}): { previewId: number; runId: string } {
  const agent = createAgent({ repoId, name: 'qa-hunter' });
  taskRefSeq += 1;
  const run = createRun({
    repoId,
    agentName: 'qa-hunter',
    agentId: agent.id,
    trigger: 'manual',
    taskRef: `plan:T${taskRefSeq}`,
    runnerUsed: 'claude',
  });
  transitionRun(run.id, 'done', { outputSummary: 'ok' });
  const previewId = insertPreview({
    repoId,
    runId: run.id,
    agentName: 'qa-hunter',
    payload: {
      kind: 'issue',
      title: opts.title,
      body: 'details',
      labels: ['obelisk:fix', 'severity:P1'],
    },
  });
  markPreviewPublished({
    sourcePreviewId: previewId,
    runId: run.id,
    issueNumber: opts.issueNumber,
    htmlUrl: `https://github.com/test/x/issues/${opts.issueNumber}`,
  });
  return { previewId, runId: run.id };
}

describe('listPublishedOpenPreviewIssueNumbersForRepo', () => {
  it('returns every published-and-not-dismissed preview with its issue number', () => {
    const a = makePublishedPreview({ title: 'a', issueNumber: 30 });
    const b = makePublishedPreview({ title: 'b', issueNumber: 28 });
    makePublishedPreview({ title: 'c', issueNumber: 26 });

    const rows = listPublishedOpenPreviewIssueNumbersForRepo(repoId);
    expect(rows.map((r) => r.issueNumber).sort((x, y) => x - y)).toEqual([26, 28, 30]);
    expect(rows.find((r) => r.issueNumber === 30)?.previewId).toBe(a.previewId);
    expect(rows.find((r) => r.issueNumber === 28)?.previewId).toBe(b.previewId);
  });

  it('excludes previews that were already dismissed by the user', () => {
    const a = makePublishedPreview({ title: 'a', issueNumber: 30 });
    makePublishedPreview({ title: 'b', issueNumber: 28 });
    markPreviewDismissed({ sourcePreviewId: a.previewId, runId: a.runId });

    const rows = listPublishedOpenPreviewIssueNumbersForRepo(repoId);
    // Only the non-dismissed one comes back.
    expect(rows.map((r) => r.issueNumber)).toEqual([28]);
  });

  it('ignores previews from other repos', () => {
    makePublishedPreview({ title: 'mine', issueNumber: 30 });
    const otherRepoId = createRepo({
      githubFullName: 'test/other',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'prs',
      defaultRunner: 'claude',
    }).id;
    const otherAgent = createAgent({ repoId: otherRepoId, name: 'qa-hunter' });
    const otherRun = createRun({
      repoId: otherRepoId,
      agentName: 'qa-hunter',
      agentId: otherAgent.id,
      trigger: 'manual',
      taskRef: 'plan:other',
      runnerUsed: 'claude',
    });
    transitionRun(otherRun.id, 'done', { outputSummary: 'ok' });
    const otherPreviewId = insertPreview({
      repoId: otherRepoId,
      runId: otherRun.id,
      agentName: 'qa-hunter',
      payload: { kind: 'issue', title: 'theirs', body: '', labels: [] },
    });
    markPreviewPublished({
      sourcePreviewId: otherPreviewId,
      runId: otherRun.id,
      issueNumber: 999,
      htmlUrl: 'https://github.com/test/other/issues/999',
    });

    const rows = listPublishedOpenPreviewIssueNumbersForRepo(repoId);
    expect(rows.map((r) => r.issueNumber)).toEqual([30]);
  });

  it('skips previews that were never published (preview_markers has no published row)', () => {
    const agent = createAgent({ repoId, name: 'qa-hunter' });
    const run = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'plan:unpublished',
      runnerUsed: 'claude',
    });
    transitionRun(run.id, 'done', { outputSummary: 'ok' });
    insertPreview({
      repoId,
      runId: run.id,
      agentName: 'qa-hunter',
      payload: { kind: 'issue', title: 'pending', body: '', labels: [] },
    });

    const rows = listPublishedOpenPreviewIssueNumbersForRepo(repoId);
    expect(rows).toEqual([]);
  });
});

describe('auto-dismissing a closed-issue finding', () => {
  it('makes the preview vanish from listPreviewsForRepo (renderer filters !f.dismissed)', () => {
    const { previewId, runId } = makePublishedPreview({ title: 'closed-bug', issueNumber: 30 });
    expect(listPreviewsForRepo(repoId).find((p) => p.id === previewId)?.dismissed).toBe(false);

    // Simulates what backlog-sync.ts does when gh.issues.get returns state:'closed'.
    markPreviewDismissed({ sourcePreviewId: previewId, runId });

    // The renderer filters with `!f.dismissed`, so the finding is now hidden.
    expect(listPreviewsForRepo(repoId).find((p) => p.id === previewId)?.dismissed).toBe(true);
  });

  it('is idempotent — re-marking a dismissed preview is a no-op', () => {
    const { previewId, runId } = makePublishedPreview({ title: 'closed', issueNumber: 5 });
    markPreviewDismissed({ sourcePreviewId: previewId, runId });
    // The UNIQUE(preview_id, kind) index + ON CONFLICT in markPreviewDismissed
    // means a second sweep round can't insert a duplicate row or throw.
    expect(() => markPreviewDismissed({ sourcePreviewId: previewId, runId })).not.toThrow();
    expect(listPreviewsForRepo(repoId).find((p) => p.id === previewId)?.dismissed).toBe(true);
  });
});
