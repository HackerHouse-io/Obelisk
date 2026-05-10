import { simpleGit } from 'simple-git';
import type { RunOpts, RunResult } from './types';

/**
 * Materialize the patch the runner produced by walking the worktree's git
 * state. The agent may either:
 *   1. Leave its edits unstaged → we `git add --all`, then read `--cached`.
 *   2. Commit them itself (Bug Fixer's Prove-It pattern explicitly tells
 *      the agent to land the failing test and the fix as separate commits)
 *      → after `git add --all` nothing is staged, so we fall back to
 *      `baseRef..HEAD` to surface the work the agent committed.
 *
 * Returning `no_changes` here costs the user the entire run (often 10+
 * minutes of agent work and a couple of dollars in tokens) — so the
 * fallback to committed work is non-negotiable.
 *
 * `reasoning` is preserved on the `no_changes` path because read-only
 * agents (qa-hunter, manual-qa) emit findings on stdout; the orchestrator
 * coerces their `no_changes` to ok and parses BEGIN_FINDINGS out of the
 * carried-through reasoning.
 */
export async function collectPatch(opts: RunOpts, reasoning: string): Promise<RunResult> {
  const git = simpleGit(opts.worktreePath);
  await git.add('--all');
  const status = await git.status();

  if (status.files.length > 0) {
    const diff = await git.diff(['--cached']);
    const filesChanged = [...new Set(status.files.map((f) => f.path))].sort();
    return { ok: true, patch: { diff, filesChanged }, testsRun: [], reasoning };
  }

  if (opts.baseRef) {
    try {
      const aheadCount = (await git.raw(['rev-list', '--count', `${opts.baseRef}..HEAD`])).trim();
      if (aheadCount !== '' && aheadCount !== '0') {
        const diff = await git.diff([`${opts.baseRef}...HEAD`]);
        const filesRaw = await git.raw(['diff', '--name-only', `${opts.baseRef}...HEAD`]);
        const filesChanged = filesRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .sort();
        return { ok: true, patch: { diff, filesChanged }, testsRun: [], reasoning };
      }
    } catch {
      // baseRef no longer resolves in the worktree (rebase, GC) — fall
      // through to the no_changes path so the user at least sees the
      // reasoning.
    }
  }

  return {
    ok: false,
    reason: 'no_changes',
    detail: 'worktree had no staged changes after run',
    reasoning,
  };
}
