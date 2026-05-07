import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo, setRepoMode, getRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { createBacklogItem } from '../../src/main/db/backlog';
import { listArtifacts } from '../../src/main/db/evidence';
import { runAgent } from '../../src/main/orchestrator/run';
import { MockRunner, type MockRecipe } from '../helpers/mock-runner';
import { seedTestPlanFile } from '../helpers/seed-plan';
import type { CodingAgentRunner } from '../../src/main/runners/types';

// Stub Octokit so neither selectTask's fetchIssueAuthor nor publish's
// gh.* calls actually hit the network. The orchestrator's mode gate runs
// AFTER `getGithub()` succeeds, so returning a fake client lets us test
// MODE_TOO_LOW vs AUTH_REQUIRED in isolation.
const fakeGh = {
  issues: {
    get: vi.fn().mockResolvedValue({
      data: { number: 142, title: 'Test issue', user: { login: 'fixture-author' } },
    }),
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn().mockResolvedValue({
      data: { number: 999, html_url: 'https://github.com/test/x/issues/999' },
    }),
    listForRepo: vi.fn().mockResolvedValue({ data: [] }),
    createComment: vi.fn().mockResolvedValue({
      data: { id: 1, html_url: 'https://example.test/comment' },
    }),
  },
  pulls: {
    create: vi.fn().mockResolvedValue({
      data: { number: 211, html_url: 'https://github.com/test/x/pull/211' },
    }),
    list: vi.fn().mockResolvedValue({ data: [] }),
    createReview: vi.fn().mockResolvedValue({ data: { id: 100 } }),
  },
};

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

const FIXED_BUG_TS = `// auth/session.ts — fixed
export function getSameSite(secure) {
  if (!secure) return 'Lax';
  return 'None';
}
`;

const FAILING_TEST_TS = `// auth/session.test.ts
import { describe, it, expect } from 'vitest';
import { getSameSite } from './session';
describe('getSameSite', () => {
  it('returns None when secure', () => {
    expect(getSameSite(true)).toBe('None');
  });
});
`;

const NEW_REACT_COMPONENT = `import { useState } from 'react';
export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

let tmpRoot: string;
let repoPath: string;

async function makeFixtureRepo(): Promise<string> {
  const path = join(tmpRoot, 'repo');
  mkdirSync(join(path, 'auth'), { recursive: true });
  writeFileSync(
    join(path, 'auth/session.ts'),
    `export function getSameSite() { return 'Lax'; }\n`,
  );
  writeFileSync(`${path}/README.md`, '# fixture\n');
  const git = simpleGit(path);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);
  return path;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-failure-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
  repoPath = await makeFixtureRepo();

  // Reset mock call counts between tests.
  for (const group of Object.values(fakeGh)) {
    for (const fn of Object.values(group)) {
      if (typeof fn === 'object' && fn !== null && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    }
  }
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function bugFixerRecipe(filesToWrite: { path: string; contents: string }[]): MockRecipe {
  return {
    filesToWrite,
    reasoning: 'fix(auth): emit SameSite=None when Secure is true',
  };
}

function factoryFor(recipe: MockRecipe): (kind: 'claude' | 'codex') => CodingAgentRunner {
  return (kind) => new MockRunner(kind, recipe);
}

describe('orchestrator: failure modes (TEST_PLAN.md §5)', () => {
  it('EVIDENCE_INCOMPLETE — UI touched but no screenshot pauses the run', async () => {
    const repo = createRepo({
      githubFullName: 'test/react-buggy',
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
      title: 'UI bug',
      kind: 'bug',
      priorityLabel: 'P1',
    });

    const recipe = bugFixerRecipe([
      { path: 'src/Counter.tsx', contents: NEW_REACT_COMPONENT },
      { path: 'src/Counter.test.tsx', contents: FAILING_TEST_TS },
    ]);

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factoryFor(recipe),
    });

    expect(result.finalState).toBe('paused');
    expect(result.reason).toBe('EVIDENCE_INCOMPLETE');

    const auditRows = getDb()
      .prepare<[string, string], { payload: string }>(
        "SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?",
      )
      .all(result.runId, 'evidence_check');
    expect(auditRows.length).toBe(1);
    const payload = JSON.parse(auditRows[0]!.payload) as {
      result: string;
      missing: string[];
    };
    expect(payload.result).toBe('fail');
    expect(payload.missing).toContain('ui_screenshot_if_ui_touched');
  });

  it('TIMEOUT — runner reports timeout and the run is marked failed with TIMEOUT', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
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
      title: 'X',
      kind: 'bug',
      priorityLabel: 'P1',
    });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factoryFor({
        filesToWrite: [],
        failWith: { reason: 'timeout', detail: '> 30 min' },
      }),
    });

    expect(result.finalState).toBe('failed');
    expect(result.reason).toBe('timeout');

    const run = getDb()
      .prepare<[string], { error_code: string | null }>(
        'SELECT error_code FROM runs WHERE id = ?',
      )
      .get(result.runId);
    expect(run?.error_code).toBe('TIMEOUT');
  });

  it('RUNNER_NO_OUTPUT — empty-stderr non-zero exit gets a distinct error code', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'test-user', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'qa-hunter',
      trigger: 'manual',
      runnerFactory: factoryFor({
        filesToWrite: [],
        failWith: {
          reason: 'non_zero_exit',
          detail: "claude exited 1 with no output. Verify 'claude' is installed and authenticated.",
        },
      }),
    });

    expect(result.finalState).toBe('failed');
    const row = getDb()
      .prepare<[string], { error_code: string | null; output_summary: string | null }>(
        'SELECT error_code, output_summary FROM runs WHERE id = ?',
      )
      .get(result.runId);
    expect(row?.error_code).toBe('RUNNER_NO_OUTPUT');
    expect(row?.output_summary).toMatch(/no output/);
  });

  it('Observe-mode QA run with zero findings ends as done with friendly summary', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'test-user', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'qa-hunter',
      trigger: 'manual',
      runnerFactory: factoryFor({
        filesToWrite: [],
        reasoning: 'Scanned. BEGIN_FINDINGS\n[]\nEND_FINDINGS',
      }),
    });

    expect(result.finalState).toBe('done');
    const row = getDb()
      .prepare<[string], { output_summary: string | null }>(
        'SELECT output_summary FROM runs WHERE id = ?',
      )
      .get(result.runId);
    expect(row?.output_summary).toBe('Plan executed; no findings.');
  });

  it('no_changes from a PR-opening agent fails the run', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
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
      title: 'X',
      kind: 'bug',
      priorityLabel: 'P1',
    });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factoryFor({ filesToWrite: [] }),
    });

    expect(result.finalState).toBe('failed');
    expect(result.reason).toBe('no_changes');
  });

  it('no_changes from a read-only agent (qa-hunter) is the success path', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'test-user', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'qa-hunter',
      trigger: 'manual',
      runnerFactory: factoryFor({
        filesToWrite: [],
        reasoning: 'Scanned. BEGIN_FINDINGS\n[]\nEND_FINDINGS',
      }),
    });

    expect(result.finalState).toBe('done');
  });

  it('mode downgrade — observe-mode publish hits MODE_TOO_LOW after evidence passes', async () => {
    const repo = createRepo({
      githubFullName: 'test/x',
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
      title: 'X',
      kind: 'bug',
      priorityLabel: 'P1',
    });

    // Downgrade BEFORE the run; the orchestrator reads `repo.mode` once at
    // the top of `runAgent`, so an inline downgrade here is observationally
    // identical to a downgrade between runner-success and publish.
    setRepoMode(repo.id, 'observe');
    expect(getRepo(repo.id)?.mode).toBe('observe');

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'bug-fixer',
      trigger: 'manual',
      runnerFactory: factoryFor(
        bugFixerRecipe([
          { path: 'auth/session.ts', contents: FIXED_BUG_TS },
          { path: 'auth/session.test.ts', contents: FAILING_TEST_TS },
        ]),
      ),
    });

    expect(result.finalState).toBe('failed');
    expect(result.reason).toMatch(/not allowed in safety mode/);

    // Evidence still got captured before the mode gate rejected the publish.
    const arts = listArtifacts(result.runId).map((a) => a.kind);
    expect(arts).toContain('patch');
    expect(arts).toContain('failing_test_diff');
  });
});
