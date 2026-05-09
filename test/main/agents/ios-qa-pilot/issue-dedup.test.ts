import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import { createRun } from '../../../../src/main/db/runs';
import { buildPublishPlan } from '../../../../src/main/agents/ios-qa-pilot/issue';
import type { IosQaFinding } from '../../../../src/main/agents/ios-qa-pilot/parser';

// One mock for both branches — toggle the in-memory `existingIssue` value.
let existingIssue: { number: number; title: string } | null = null;

vi.mock('../../../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => ({
    issues: {
      listForRepo: vi.fn(async () => ({
        data: existingIssue ? [existingIssue] : [],
      })),
    },
  })),
  invalidateGithubClient: vi.fn(),
}));

let tmp: string;
let repoId: string;
let runId: string;

const FINDING: IosQaFinding = {
  flow_id: 'flow-1',
  status: 'failed',
  symptom: 'Continue spinner forever',
  severity: 'P1',
  repro: '...',
  likely_area: 'Auth.swift',
  confidence: 0.9,
  evidence: {},
};

beforeEach(() => {
  existingIssue = null;
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-dedup-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/ios',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'issues',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
  const run = createRun({
    repoId,
    agentName: 'ios-qa-pilot',
    trigger: 'manual',
    taskRef: 'qa',
    runnerUsed: 'claude',
  });
  runId = run.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildPublishPlan', () => {
  it('files a new issue when nothing matches', async () => {
    const plan = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 0,
      runId,
    });
    expect(plan.kind).toBe('issue');
  });

  it('emits a comment instead of a duplicate when an open issue matches', async () => {
    existingIssue = { number: 42, title: '[QA iOS] Login: Continue spinner forever' };
    const plan = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 0,
      runId,
    });
    expect(plan.kind).toBe('comment');
    if (plan.kind === 'comment') expect(plan.issueNumber).toBe(42);
  });

  it('emits noop on a second call within the same cycle', async () => {
    existingIssue = { number: 42, title: '[QA iOS] Login: Continue spinner forever' };
    const first = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 0,
      runId,
    });
    expect(first.kind).toBe('comment');

    const second = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 0,
      runId,
    });
    expect(second.kind).toBe('noop');
  });

  it('comments again when the cycle bumps (after Reset progress)', async () => {
    existingIssue = { number: 42, title: '[QA iOS] Login: Continue spinner forever' };
    const first = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 0,
      runId,
    });
    expect(first.kind).toBe('comment');

    const second = await buildPublishPlan({
      repoId,
      repoFullName: 'test/ios',
      flowId: FINDING.flow_id,
      flowTitle: 'Login',
      finding: FINDING,
      refs: { screenshotArtifactIds: [] },
      cycle: 1, // simulate post-reset
      runId,
    });
    expect(second.kind).toBe('comment');
  });
});
