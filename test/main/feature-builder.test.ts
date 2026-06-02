import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun } from '../../src/main/db/runs';
import { listArtifacts } from '../../src/main/db/evidence';
import { featureBuilderHandler, parseFeatureOutput } from '../../src/main/agents/feature-builder';
import type { Repo, RunnerKind } from '../../src/shared/types';

let tmp: string;
let repo: Repo;
let runId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-fb-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repo = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude' as RunnerKind,
  });
  const run = createRun({
    repoId: repo.id,
    agentName: 'feature-builder',
    trigger: 'manual',
    taskRef: 'issue#198',
    runnerUsed: 'claude',
  });
  runId = run.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseFeatureOutput', () => {
  it('extracts the structured FEATURE_OUTPUT block', () => {
    const stdout = `prose…

BEGIN_FEATURE_OUTPUT
{
  "spec": "## Goal\\nAdd CSV export.",
  "plan": "1. Add /reports/export route.",
  "pr_title": "feat(reports): add CSV export to /reports",
  "pr_summary": "Adds a CSV download button to /reports.",
  "screenshot_path": "playwright-report/csv.png"
}
END_FEATURE_OUTPUT

…done.`;
    const out = parseFeatureOutput(stdout);
    expect(out).not.toBeNull();
    expect(out!.pr_title).toContain('CSV export');
    expect(out!.screenshot_path).toBe('playwright-report/csv.png');
  });

  it('returns null when block is missing', () => {
    expect(parseFeatureOutput('SPEC_AMBIGUOUS: who is the user?')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseFeatureOutput('BEGIN_FEATURE_OUTPUT\n{broken\nEND_FEATURE_OUTPUT')).toBeNull();
  });

  it('rejects output missing required fields', () => {
    const stdout = `BEGIN_FEATURE_OUTPUT\n{"spec":"x","plan":"y"}\nEND_FEATURE_OUTPUT`;
    expect(parseFeatureOutput(stdout)).toBeNull();
  });
});

describe('featureBuilderHandler.interpretResult', () => {
  function fakeRunResult(
    stdout: string,
    files: string[],
  ): {
    ok: true;
    patch: { diff: string; filesChanged: string[] };
    testsRun: never[];
    reasoning: string;
  } {
    return {
      ok: true,
      patch: { diff: 'diff --git a/x b/x', filesChanged: files },
      testsRun: [],
      reasoning: stdout,
    };
  }

  it('emits [spec comment, plan comment, ready-for-review PR] for an issue-driven feature', async () => {
    const stdout = `Reasoning…
BEGIN_FEATURE_OUTPUT
{
  "spec": "## Goal\\nAdd CSV export.",
  "plan": "1. /reports/export route.",
  "pr_title": "feat(reports): add CSV export",
  "pr_summary": "Adds CSV export."
}
END_FEATURE_OUTPUT`;
    const plans = await featureBuilderHandler.interpretResult({
      repo,
      task: { ref: 'issue#198', kind: 'feature', context: 'Add CSV', githubNumber: 198 },
      runResult: fakeRunResult(stdout, ['src/reports/export.ts']),
      runId,
    });
    const arr = Array.isArray(plans) ? plans : [plans];
    expect(arr).toHaveLength(3);
    expect(arr[0]!.kind).toBe('comment');
    expect(arr[1]!.kind).toBe('comment');
    expect(arr[2]!.kind).toBe('pr');
    if (arr[0]!.kind === 'comment') expect(arr[0]!.issueNumber).toBe(198);
    if (arr[2]!.kind === 'pr') expect(arr[2]!.title).toContain('CSV export');
  });

  it('omits comments when there is no GitHub issue (manual backlog item)', async () => {
    const stdout = `BEGIN_FEATURE_OUTPUT
{
  "spec": "x",
  "plan": "y",
  "pr_title": "feat: thing",
  "pr_summary": "z"
}
END_FEATURE_OUTPUT`;
    const plans = await featureBuilderHandler.interpretResult({
      repo,
      task: { ref: 'backlog#abc', kind: 'feature', context: 'Manual entry' },
      runResult: fakeRunResult(stdout, ['src/x.ts']),
      runId,
    });
    const arr = Array.isArray(plans) ? plans : [plans];
    expect(arr).toHaveLength(1);
    expect(arr[0]!.kind).toBe('pr');
  });

  it('returns [] when the runner produced no parseable output', async () => {
    const plans = await featureBuilderHandler.interpretResult({
      repo,
      task: { ref: 'issue#1', kind: 'feature', context: 'x', githubNumber: 1 },
      runResult: fakeRunResult('SPEC_AMBIGUOUS: nope', ['src/x.ts']),
      runId,
    });
    const arr = Array.isArray(plans) ? plans : [plans];
    expect(arr).toEqual([]);
  });

  it('collectEvidence registers screenshot + server log artifacts when paths exist', async () => {
    mkdirSync(join(tmp, 'playwright-report'), { recursive: true });
    mkdirSync(join(tmp, 'logs'), { recursive: true });
    writeFileSync(join(tmp, 'playwright-report/feat.png'), 'fake-png');
    writeFileSync(join(tmp, 'logs/run.txt'), 'POST /reports/export 200');

    const stdout = `BEGIN_FEATURE_OUTPUT
{
  "spec": "x",
  "plan": "y",
  "pr_title": "feat(reports): csv",
  "pr_summary": "z",
  "screenshot_path": "playwright-report/feat.png",
  "server_log_path": "logs/run.txt"
}
END_FEATURE_OUTPUT`;
    const collected = await featureBuilderHandler.collectEvidence!({
      repo,
      runId,
      worktreePath: tmp,
      runResult: fakeRunResult(stdout, ['src/reports/export.ts']),
    });

    const artifacts = listArtifacts(runId);
    const kinds = artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['log', 'screenshot']);
    for (const a of artifacts) {
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    // A captured screenshot is reported as the Tier-1 rung of the proof ladder.
    expect(collected.uiVerification).toBe('screenshot');
  });

  it('collectEvidence climbs to ui_test and persists pasted test output', async () => {
    const stdout = `BEGIN_FEATURE_OUTPUT
{
  "spec": "x",
  "plan": "y",
  "pr_title": "feat: x",
  "pr_summary": "z",
  "ui_verification": "ui_test",
  "ui_test_file": "src/x.e2e.test.tsx",
  "ui_test_output": "PASS  src/x.e2e.test.tsx (1 test)"
}
END_FEATURE_OUTPUT`;
    const collected = await featureBuilderHandler.collectEvidence!({
      repo,
      runId,
      worktreePath: tmp,
      runResult: fakeRunResult(stdout, ['src/x.tsx']),
    });
    expect(collected.uiVerification).toBe('ui_test');
    expect(collected.uiTestFile).toBe('src/x.e2e.test.tsx');
    const kinds = listArtifacts(runId).map((a) => a.kind);
    expect(kinds).toContain('test_output');
  });

  it('collectEvidence skips artifact registration when paths point to missing files', async () => {
    const stdout = `BEGIN_FEATURE_OUTPUT
{
  "spec": "x",
  "plan": "y",
  "pr_title": "feat: x",
  "pr_summary": "z",
  "screenshot_path": "no/such.png"
}
END_FEATURE_OUTPUT`;
    await featureBuilderHandler.collectEvidence!({
      repo,
      runId,
      worktreePath: tmp,
      runResult: fakeRunResult(stdout, ['src/x.ts']),
    });
    expect(listArtifacts(runId)).toHaveLength(0);
  });
});
