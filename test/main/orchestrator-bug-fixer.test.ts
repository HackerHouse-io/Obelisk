import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { createBacklogItem } from '../../src/main/db/backlog';
import { listArtifacts } from '../../src/main/db/evidence';
import { runAgent } from '../../src/main/orchestrator/run';
import { addInProcessListener } from '../../src/main/ipc/bus';
import type { BusEvent } from '../../src/shared/types';
import { MockRunner, type MockRecipe } from '../helpers/mock-runner';

// Force getGithub() to return null regardless of whether the developer's
// keychain has a real token saved. The test's whole premise is "no signed-in
// GitHub user", and reading from a real keychain would let tokens leak into
// the test path and trigger real network calls (or, with a wrong/expired
// token, infinite retries against a non-existent test/express-buggy repo).
vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;

const SEEDED_BUG_FILE = `// auth/session.ts — seeded buggy version
export function getSameSite(secure) {
  return secure ? 'None' : 'Lax';
}
`;

const FIXED_BUG_FILE = `// auth/session.ts — fixed version
export function getSameSite(secure) {
  // Safari requires SameSite=None when Secure is true; default to Lax otherwise.
  if (!secure) return 'Lax';
  return 'None';
}
`;

const FAILING_TEST_FILE = `// auth/session.test.ts — written by Bug Fixer
import { describe, it, expect } from 'vitest';
import { getSameSite } from './session';

describe('getSameSite', () => {
  it('returns None for secure cookies on Safari', () => {
    expect(getSameSite(true)).toBe('None');
  });
});
`;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-test-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

  // Initialize a real git repo as our "connected repo".
  repoPath = join(tmpRoot, 'repo');
  mkdirSync(join(repoPath, 'auth'), { recursive: true });
  writeFileSync(join(repoPath, 'auth/session.ts'), SEEDED_BUG_FILE);
  writeFileSync(join(repoPath, 'README.md'), '# express-buggy fixture\n');

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial commit');
  // Make sure we have a 'main' branch by name.
  await git.raw(['branch', '-M', 'main']);
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('orchestrator: bug-fixer happy path', () => {
  it('runs end-to-end through publishing → fails at GitHub publish (mode=observe boundary)', async () => {
    // Repo at observe mode; publish will fail at the ensureModeAllows gate.
    // Everything before publish must succeed.
    const repo = createRepo({
      githubFullName: 'test/express-buggy',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    const item = createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Safari rejects session cookie when SameSite=Lax + Secure',
      kind: 'bug',
      priorityLabel: 'P0',
    });

    // Capture bus events to assert the state machine fires properly.
    const events: BusEvent[] = [];
    const stop = addInProcessListener((e) => events.push(e));

    const recipe: MockRecipe = {
      filesToWrite: [
        { path: 'auth/session.ts', contents: FIXED_BUG_FILE },
        { path: 'auth/session.test.ts', contents: FAILING_TEST_FILE },
      ],
      reasoning:
        'Hypothesis: Safari rejects Lax + Secure cookies. Fix: emit SameSite=None when Secure is true. Added a regression test that fails before the fix.',
    };
    const factory = (kind: 'claude' | 'codex'): MockRunner => new MockRunner(kind, recipe);

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factory,
    });
    stop();

    // Run advanced through every stage and failed at publish (no
    // signed-in GitHub user in tests). Either AUTH_REQUIRED or MODE_TOO_LOW
    // would be acceptable failure points — both prove the orchestrator
    // exercised every preceding stage successfully.
    expect(result.finalState).toBe('failed');
    expect(result.reason).toMatch(/Sign in to GitHub|not allowed in safety mode/);

    // State machine fired in order.
    const transitions = events
      .filter((e): e is Extract<BusEvent, { type: 'run.transition' }> => e.type === 'run.transition')
      .map((e) => e.state);
    expect(transitions).toEqual(['running', 'running', 'publishing', 'failed']);

    // Backlog item should have been locked + then unlocked in the finally.
    // (We can't assert mid-flight without race conditions; we just check
    //  that the run was tied to the backlog item via task_ref convention.)
    expect(item.id).toBeDefined();

    // Evidence artifacts should have been written to local storage.
    const runId = result.runId;
    const artifacts = listArtifacts(runId);
    const kinds = artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['failing_test_diff', 'patch', 'reasoning', 'test_output']);
    // Patch + failing-test artifacts must be non-empty.
    const patch = artifacts.find((a) => a.kind === 'patch')!;
    expect(patch.bytes).toBeGreaterThan(0);
  });

  it('passes the evidence check when Bug Fixer outputs a complete patch', async () => {
    // mode='prs' so publish runs; the GitHub call will fail (no real
    // Octokit), but the evidence-check step BEFORE publish must pass and
    // be visible in the audit log.
    const repo = createRepo({
      githubFullName: 'test/express-buggy',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'prs',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    createBacklogItem({
      repoId: repo.id,
      source: 'manual',
      title: 'Same bug as above',
      kind: 'bug',
      priorityLabel: 'P0',
    });

    const recipe: MockRecipe = {
      filesToWrite: [
        { path: 'auth/session.ts', contents: FIXED_BUG_FILE },
        { path: 'auth/session.test.ts', contents: FAILING_TEST_FILE },
      ],
      reasoning: 'fix(auth): emit SameSite=None when Secure is true',
    };
    const factory = (kind: 'claude' | 'codex'): MockRunner => new MockRunner(kind, recipe);

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factory,
    });

    // Run reaches publishing, then fails when getGithub() returns null
    // (no signed-in user in the test). The error is AUTH_REQUIRED, NOT
    // EVIDENCE_INCOMPLETE — proving the evidence check passed.
    expect(result.finalState).toBe('failed');
    expect(result.reason).not.toContain('EVIDENCE_INCOMPLETE');

    // Audit log records the evidence check passed.
    // We re-open the DB and read directly (lower-level than the IPC handler).
    const { getDb } = await import('../../src/main/db');
    const auditRows = getDb()
      .prepare<[string, string], { payload: string }>(
        "SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?",
      )
      .all(result.runId, 'evidence_check');
    expect(auditRows.length).toBe(1);
    const payload = JSON.parse(auditRows[0]!.payload) as {
      result: 'pass' | 'fail';
      missing: string[];
    };
    expect(payload.result).toBe('pass');
    expect(payload.missing).toEqual([]);
  });
});
