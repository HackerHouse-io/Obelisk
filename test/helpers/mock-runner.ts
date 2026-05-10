import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { CodingAgentRunner, RunOpts, RunResult } from '../../src/main/runners/types';

export interface MockRecipe {
  /** Files to create or replace inside the worktree before "running". */
  filesToWrite: { path: string; contents: string }[];
  /** Files to delete from the worktree before "running". */
  filesToDelete?: string[];
  /** Reasoning text the runner returns. */
  reasoning?: string;
  /** Force a failure. If set, the run returns ok=false with this reason. */
  failWith?: { reason: 'timeout' | 'crash' | 'non_zero_exit' | 'no_changes'; detail: string };
  /**
   * Simulate the Bug Fixer's Prove-It pattern: stage AND commit the
   * recipe's files inside the worktree before returning, then let the
   * runner's `collectPatch` discover the patch via `baseRef..HEAD`
   * instead of `git status --cached`. Without this flag the runner's
   * default path stages files and reads the cached diff.
   */
  commitInsteadOfStage?: boolean;
}

/**
 * MockRunner: doesn't spawn anything. Instead, applies a fixture-defined
 * mutation to the worktree and reports the resulting git diff as a
 * RunResult. Used by L2 tests to exercise the orchestrator end-to-end.
 *
 * Recipes can be keyed by contentHash so different prompts produce different
 * patches; for Phase 4 we just take a single recipe at construction time.
 */
export class MockRunner implements CodingAgentRunner {
  readonly kind: 'claude' | 'codex';
  private readonly recipe: MockRecipe;

  constructor(kind: 'claude' | 'codex', recipe: MockRecipe) {
    this.kind = kind;
    this.recipe = recipe;
  }

  async isInstalled(): ReturnType<CodingAgentRunner['isInstalled']> {
    return { ok: true, version: 'mock-1.0' };
  }

  async run(opts: RunOpts, _abort: AbortSignal): Promise<RunResult> {
    if (this.recipe.failWith) {
      return { ok: false, reason: this.recipe.failWith.reason, detail: this.recipe.failWith.detail };
    }

    opts.onAudit({
      at: new Date().toISOString(),
      kind: 'state',
      payload: { stage: 'mock-applying', runner: this.kind },
    });

    for (const f of this.recipe.filesToWrite) {
      const target = join(opts.worktreePath, f.path);
      const dir = target.substring(0, target.lastIndexOf('/'));
      // Make sure the dir exists.
      const fs = await import('node:fs');
      fs.mkdirSync(dir, { recursive: true });
      writeFileSync(target, f.contents, 'utf8');
    }
    for (const path of this.recipe.filesToDelete ?? []) {
      const target = join(opts.worktreePath, path);
      if (existsSync(target)) {
        const fs = await import('node:fs');
        fs.unlinkSync(target);
      }
    }

    const git = simpleGit(opts.worktreePath);
    await git.add('--all');

    if (this.recipe.commitInsteadOfStage) {
      // Apply the same git config a fresh runner worktree gets in
      // production so simple-git can `commit` here (the orchestrator's
      // publisher does this just before its own commit, but the recipe
      // commits BEFORE we reach the publisher).
      await git.addConfig('user.name', 'Mock Agent');
      await git.addConfig('user.email', 'mock@example.com');
      await git.addConfig('commit.gpgsign', 'false');
      await git.commit('mock: agent committed its own work', { '--no-verify': null });
    }

    // Fall through to the shared collectPatch path so the test exercises
    // the same runner code as production (staged → diff --cached, or
    // committed → baseRef..HEAD).
    const { collectPatch } = await import('../../src/main/runners/collect-patch');
    const result = await collectPatch(opts, this.recipe.reasoning ?? 'Mock run completed.');
    if (result.ok) {
      result.testsRun = [
        {
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 1234,
          summary: 'PASS  src/auth/session.test.ts (3 tests)',
        },
      ];
    }
    return result;
  }
}

/** Helper used by tests: read a file from the worktree. */
export function readWorktreeFile(worktreePath: string, relativePath: string): string {
  return readFileSync(join(worktreePath, relativePath), 'utf8');
}
