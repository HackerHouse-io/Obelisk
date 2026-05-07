/**
 * Regression test for the "QA Hunter found 0 findings on a real repo with
 * obvious bugs" failure mode.
 *
 * The cause: read-only agents (qa-hunter, manual-qa) emit BEGIN_FINDINGS on
 * stdout. The runner's `no_changes` failure variant (their normal success
 * path) was dropping that stdout, and the orchestrator's coercion to
 * ok-with-empty-patch hardcoded `reasoning: ''` — so `interpretResult`
 * parsed an empty string and produced zero findings even when the model
 * surfaced real bugs.
 *
 * This test wires up a MockRunner that returns `no_changes` with reasoning
 * containing two findings, then asserts the orchestrator's preview path
 * fires twice in observe mode.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { runAgent } from '../../src/main/orchestrator/run';
import { seedTestPlanFile } from '../helpers/seed-plan';
import type { CodingAgentRunner, RunOpts, RunResult } from '../../src/main/runners/types';

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => null),
  invalidateGithubClient: vi.fn(),
}));

let tmpRoot: string;
let repoPath: string;

const QA_HUNTER_OUTPUT = `Reasoning prose first, then the structured block.

BEGIN_FINDINGS
[
  {
    "title": "Stale streak after reset",
    "severity": "P0",
    "repro": "1. Complete a lesson; 2. Settings → Reset; 3. Streak survives.",
    "suspected_files": ["WealthLab/AppState.swift:361"],
    "suggested_test": "Seed streak; reset; expect zero."
  },
  {
    "title": "Lesson-only courses never grant credentials",
    "severity": "P1",
    "repro": "1. Mark every credit lesson done; 2. Open Dean's List; 3. No credential.",
    "suspected_files": ["WealthLab/Models/Credential.swift:45"],
    "suggested_test": "Complete every unit; expect earnedCredentials non-empty."
  }
]
END_FINDINGS
`;

class StdoutOnlyMockRunner implements CodingAgentRunner {
  readonly kind: 'claude' | 'codex' = 'codex';
  async isInstalled() {
    return { ok: true as const, version: 'mock-1.0' };
  }
  async run(_opts: RunOpts, _abort: AbortSignal): Promise<RunResult> {
    // Mirrors the read-only agent's normal exit: nothing staged in the
    // worktree, but a real BEGIN_FINDINGS block on stdout.
    return {
      ok: false,
      reason: 'no_changes',
      detail: 'worktree had no staged changes after run',
      reasoning: QA_HUNTER_OUTPUT,
    };
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-qa-stdout-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();

  repoPath = join(tmpRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('QA Hunter: stdout passthrough on no_changes', () => {
  it("threads runner's stdout into interpretResult so observe-mode previews are produced", async () => {
    const repo = createRepo({
      githubFullName: 'test/wealthlab',
      localPath: repoPath,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'codex',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    addToAllowlist(repo.id, 'fixture-author', 'auto');
    seedTestPlanFile({ repoPath, agentName: 'qa-hunter' });

    const result = await runAgent({
      repoId: repo.id,
      agentName: 'qa-hunter',
      trigger: 'manual',
      runnerFactory: () => new StdoutOnlyMockRunner(),
    });

    expect(result.finalState).toBe('done');
    expect(result.reason).toBe('previewed');

    // The findings should land in audit_log as 'preview' rows. Two of them.
    const previews = getDb()
      .prepare<[string, string], { payload: string }>(
        "SELECT payload FROM audit_log WHERE run_id = ? AND kind = ?",
      )
      .all(result.runId, 'preview');
    expect(previews.length).toBe(2);

    const titles = previews
      .map((r) => JSON.parse(r.payload) as { title: string })
      .map((p) => p.title);
    expect(titles.some((t) => t.includes('Stale streak'))).toBe(true);
    expect(titles.some((t) => t.includes('Lesson-only courses'))).toBe(true);

    // Run summary should reflect both findings.
    const run = getDb()
      .prepare<[string], { output_summary: string }>(
        'SELECT output_summary FROM runs WHERE id = ?',
      )
      .get(result.runId);
    expect(run?.output_summary).toMatch(/2 previews/);
  });
});
