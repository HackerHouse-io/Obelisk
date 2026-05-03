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
  /** Override the runner's emitted patch (defaults to whatever git status sees). */
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
    const status = await git.status();
    if (status.files.length === 0) {
      return { ok: false, reason: 'no_changes', detail: 'mock recipe produced no diff' };
    }
    const diff = await git.diff(['--cached']);
    const filesChanged = [...new Set(status.files.map((f) => f.path))].sort();

    return {
      ok: true,
      patch: { diff, filesChanged },
      testsRun: [
        {
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 1234,
          summary: 'PASS  src/auth/session.test.ts (3 tests)',
        },
      ],
      reasoning: this.recipe.reasoning ?? 'Mock run completed.',
    };
  }
}

/** Helper used by tests: read a file from the worktree. */
export function readWorktreeFile(worktreePath: string, relativePath: string): string {
  return readFileSync(join(worktreePath, relativePath), 'utf8');
}
