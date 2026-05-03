import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { recordArtifact } from '../../src/main/db/evidence';
import { createRun } from '../../src/main/db/runs';
import { checkEvidence } from '../../src/main/evidence/check';
import { inferChangeKind } from '../../src/main/evidence/infer-change-kind';
import { renderPrBody } from '../../src/main/evidence/pr-body';

let tmpRoot: string;
let runId: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-evidence-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/x',
    localPath: tmpRoot,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  });
  const run = createRun({
    repoId: repo.id,
    agentName: 'bug-fixer',
    trigger: 'manual',
    taskRef: 'manual:test',
    runnerUsed: 'claude',
  });
  runId = run.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('inferChangeKind', () => {
  it('classifies bug-fixer output as bug_fix', () => {
    const out = inferChangeKind({
      agentName: 'bug-fixer',
      filesChanged: ['src/auth/session.ts', 'src/auth/session.test.ts'],
    });
    expect(out.kind).toBe('bug_fix');
    expect(out.uiTouched).toBe(false);
    expect(out.backendTouched).toBe(true);
  });

  it('detects UI files', () => {
    const out = inferChangeKind({
      agentName: 'feature-builder',
      filesChanged: ['src/components/Login.tsx', 'src/components/Login.test.tsx'],
    });
    expect(out.kind).toBe('new_feature');
    expect(out.uiTouched).toBe(true);
  });

  it('treats test-only paths as backend if extension matches but uiTouched=false', () => {
    const out = inferChangeKind({
      agentName: 'bug-fixer',
      filesChanged: ['src/api.test.ts'],
    });
    expect(out.uiTouched).toBe(false);
    expect(out.backendTouched).toBe(false); // it's a test file, excluded
  });
});

describe('checkEvidence', () => {
  it('passes for bug_fix when failing_test_diff + test_output are present', () => {
    recordArtifact({ runId, kind: 'failing_test_diff', path: 'a', bytes: 10, sha256: 'x' });
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    const result = checkEvidence({
      runId,
      changeKind: 'bug_fix',
      inferred: {
        kind: 'bug_fix',
        uiTouched: false,
        backendTouched: true,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails for bug_fix when failing_test_diff is missing', () => {
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    const result = checkEvidence({
      runId,
      changeKind: 'bug_fix',
      inferred: {
        kind: 'bug_fix',
        uiTouched: false,
        backendTouched: true,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('failing_test_diff');
  });

  it('fails for bug_fix when UI touched but no screenshot', () => {
    recordArtifact({ runId, kind: 'failing_test_diff', path: 'a', bytes: 10, sha256: 'x' });
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    const result = checkEvidence({
      runId,
      changeKind: 'bug_fix',
      inferred: {
        kind: 'bug_fix',
        uiTouched: true,
        backendTouched: false,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('ui_screenshot_if_ui_touched');
  });

  it('passes for new_feature when all required + non-conditional items present', () => {
    recordArtifact({ runId, kind: 'patch', path: 'p', bytes: 10, sha256: 'p' });
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    const result = checkEvidence({
      runId,
      changeKind: 'new_feature',
      inferred: {
        kind: 'new_feature',
        uiTouched: false,
        backendTouched: false,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('refactor + UI touched needs before+after screenshots (one is not enough)', () => {
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    recordArtifact({ runId, kind: 'screenshot', path: 's1', bytes: 100, sha256: 'aaa' });
    const result = checkEvidence({
      runId,
      changeKind: 'refactor',
      inferred: {
        kind: 'refactor',
        uiTouched: true,
        backendTouched: false,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('before_after_screenshot_if_ui_touched');
  });

  it('zero-byte artifacts do not satisfy a requirement', () => {
    recordArtifact({ runId, kind: 'failing_test_diff', path: 'a', bytes: 0, sha256: 'x' });
    recordArtifact({ runId, kind: 'test_output', path: 'b', bytes: 10, sha256: 'y' });
    const result = checkEvidence({
      runId,
      changeKind: 'bug_fix',
      inferred: {
        kind: 'bug_fix',
        uiTouched: false,
        backendTouched: true,
        hasNonTestSourceChanges: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('failing_test_diff');
  });
});

describe('renderPrBody', () => {
  it('renders the four ## Evidence subheadings in order', () => {
    const result = checkEvidence({
      runId,
      changeKind: 'bug_fix',
      inferred: {
        kind: 'bug_fix',
        uiTouched: false,
        backendTouched: true,
        hasNonTestSourceChanges: true,
      },
    });
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId,
      taskRef: 'issue#142',
      summary: 'fix(auth): emit SameSite=None when Secure',
      reasoning: 'The bug was…',
      evidence: result,
    });
    expect(body).toContain('## Summary');
    expect(body).toContain('## Evidence');
    expect(body).toContain('### Tests');
    expect(body).toContain('### Screenshots');
    expect(body).toContain('### Logs');
    expect(body).toContain('### Reasoning');
    expect(body).toContain('## Reasoning');
    expect(body).toContain('Authored by Obelisk (bug-fixer)');
    expect(body).toContain('Task: issue#142');
  });
});
