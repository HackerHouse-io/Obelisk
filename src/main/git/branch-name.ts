/**
 * Build a descriptive head-branch name for an Obelisk PR.
 *
 * The worktree branch is created as `obelisk/<runId>` before the agent runs
 * (see createWorktree), so the descriptive name can only be derived once the
 * PR title exists — at publish time. We slugify the title and append a short
 * suffix from the runId so two PRs with similar titles never collide on the
 * same branch (mirrors the `playbook-<short-ulid>` pattern).
 *
 * e.g. buildBranchName('fix: Product load failure shows hard-coded prices', '01KSRFB3T8G7QNZYYVRYTGF270')
 *   -> 'obelisk/fix-product-load-failure-shows-hard-coded-prices-ytgf270'
 */
export function buildBranchName(title: string, runId: string): string {
  const slug = slugify(title);
  const suffix =
    runId
      .slice(-7)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'run';
  return `obelisk/${slug}-${suffix}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48)
      .replace(/-$/, '') || 'change'
  );
}
