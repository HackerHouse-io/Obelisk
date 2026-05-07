import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, deleteRun, transitionRun } from '../../src/main/db/runs';
import {
  getPreviewById,
  insertPreview,
  listOpenPreviewTitlesForRepo,
  listPreviewsForRepo,
  markPreviewDismissed,
  markPreviewPublished,
} from '../../src/main/db/previews';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-preview-survival-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

let taskRefSeq = 0;
function makeRunAndPreview(title: string): { runId: string; previewId: number } {
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
  // Move the run out of `queued` so deleteRun is allowed (it refuses to
  // delete still-active runs).
  transitionRun(run.id, 'done', { outputSummary: 'ok' });
  const previewId = insertPreview({
    repoId,
    runId: run.id,
    agentName: 'qa-hunter',
    payload: {
      kind: 'issue',
      title,
      body: '## Severity\nP1\n\n## Repro\nstuff',
      labels: ['obelisk:fix', 'severity:P1'],
    },
  });
  return { runId: run.id, previewId };
}

describe('previews survive deletion of their originating run', () => {
  it('listPreviewsForRepo still returns the finding after the run is deleted', () => {
    const { runId, previewId } = makeRunAndPreview('[bug] Reset progress leaves streak state behind');
    expect(listPreviewsForRepo(repoId)).toHaveLength(1);

    deleteRun(runId);
    const after = listPreviewsForRepo(repoId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(previewId);
    expect(after[0]!.title).toBe('[bug] Reset progress leaves streak state behind');
    // Run is gone — runId field on the preview is empty (string-coerced
    // null) so renderer treats it as "originating run was cleaned up".
    expect(after[0]!.runId).toBe('');
  });

  it('getPreviewById still resolves after the run is deleted', () => {
    const { runId, previewId } = makeRunAndPreview('[bug] Lesson-backed courses');
    deleteRun(runId);
    const found = getPreviewById(previewId);
    expect(found).not.toBeNull();
    expect(found!.finding.title).toBe('[bug] Lesson-backed courses');
  });

  it('listOpenPreviewTitlesForRepo continues to dedup after run deletion', () => {
    const { runId } = makeRunAndPreview('[bug] Already-known issue');
    deleteRun(runId);
    expect(listOpenPreviewTitlesForRepo(repoId)).toContain('[bug] Already-known issue');
  });

  it('dismiss + publish markers persist after the run is deleted', () => {
    const { runId, previewId } = makeRunAndPreview('[bug] one');
    const second = makeRunAndPreview('[bug] two');
    markPreviewDismissed({ sourcePreviewId: previewId, runId });
    markPreviewPublished({
      sourcePreviewId: second.previewId,
      runId: second.runId,
      issueNumber: 42,
      htmlUrl: 'https://example.com/issues/42',
    });
    deleteRun(runId);
    deleteRun(second.runId);

    const list = listPreviewsForRepo(repoId);
    const dismissed = list.find((p) => p.id === previewId);
    const published = list.find((p) => p.id === second.previewId);
    expect(dismissed?.dismissed).toBe(true);
    expect(published?.published).toEqual(
      expect.objectContaining({ issueNumber: 42, htmlUrl: 'https://example.com/issues/42' }),
    );
  });

  it('deleting the repo still cascades all previews (the right invariant)', () => {
    makeRunAndPreview('[bug] tied to repo');
    expect(listPreviewsForRepo(repoId)).toHaveLength(1);
    // Delete the repo via raw SQL (no helper exposed) — check cascade.
    getDb().prepare('DELETE FROM repos WHERE id = ?').run(repoId);
    expect(listPreviewsForRepo(repoId)).toHaveLength(0);
  });
});
