import type { SimpleGit } from 'simple-git';
import { ObeliskError } from '../../shared/errors';

/** Remote-side rejections that should surface as a friendly PUSH_REJECTED
 *  instead of a generic INTERNAL crash. These come from the SERVER (protected
 *  branch, pre-receive hook, LFS quota) — `--no-verify` can't bypass them. */
const REMOTE_REJECTION =
  /\[remote rejected\]|pre-receive hook declined|! \[rejected\]|protected branch|GH006|exceeded.*quota|gh\.io\/lfs/i;

/**
 * Push a run's branch to origin, bypassing the target repo's LOCAL git hooks.
 *
 * Runs happen in an ephemeral git worktree that has no `node_modules` (it's
 * gitignored, so a fresh worktree never has it). A repo with a husky `pre-push`
 * hook — e.g. one that runs `vitest run` / `npm run test:frontend` — therefore
 * fails EVERY push with "Cannot find module 'vitest/config'", aborting the push
 * and failing the whole run regardless of how good the fix is. This was the
 * dominant Bug Fixer failure.
 *
 * `--no-verify` skips the local pre-push hook. That's correct here: the local
 * hook is a developer-machine convenience, and the repo's CI is the real gate
 * for the PR we're opening. (The commit step already uses `--no-verify` for the
 * same reason.) Server-side rejections are unaffected and still surface as
 * PUSH_REJECTED.
 */
export async function pushRunBranch(git: SimpleGit, branch: string): Promise<void> {
  try {
    await git.push(['--no-verify', '--set-upstream', 'origin', branch]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (REMOTE_REJECTION.test(detail)) {
      throw new ObeliskError(
        'PUSH_REJECTED',
        `GitHub rejected the push to ${branch}: ${detail.slice(0, 400)}`,
        'A protected-branch rule, pre-receive hook, or LFS limit blocked the push. Check the repo’s branch protections / hooks, then retry.',
      );
    }
    throw e;
  }
}
