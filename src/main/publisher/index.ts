import { simpleGit } from 'simple-git';
import { getGithub } from '../github/client';
import { getAuthedLogin } from '../auth/token-store';
import { ObeliskError } from '../../shared/errors';
import type { Repo, SafetyMode } from '../../shared/types';
import type { PublishPlan } from '../agents/types';
import { resolveAttribution, applyGitConfig, renderCommitMessage } from './attribution';
import { OBELISK_LABELS } from './labels';
import { mirrorEvidenceToRepo } from './artifact-mirror';

export interface PublishInput {
  repo: Repo;
  runId: string;
  agentName: import('../../shared/types').AgentName;
  /** Required for `plan.kind === 'pr'`; ignored otherwise. */
  worktreePath?: string;
  /** Required for `plan.kind === 'pr'`; ignored otherwise. */
  branch?: string;
  /** From repos.attribution_mode (Phase 9 surfaces this in Settings). */
  attributionMode?: 'user' | 'bot' | 'custom';
  attributionCustom?: { name?: string; email?: string };
  /** The plan from agent.interpretResult — what should be created on GitHub. */
  plan: PublishPlan;
  /** PR-body Summary line for the commit message. Required for `plan.kind === 'pr'`. */
  commitSubject?: string;
  /** Multi-line commit body. */
  commitBody?: string;
  /** Issue or PR number this run is tied to (for label lifecycle). */
  sourceIssueNumber?: number;
  /** PR number we're operating on (for review plans). */
  sourcePrNumber?: number;
  /**
   * Set when this publish is appending a fix-up commit to an existing PR
   * (e.g. CI-failure auto-fix retry). When provided on a `pr` plan the
   * publisher commits + pushes to the branch but skips `gh.pulls.create`,
   * letting GitHub auto-attach the new commit. The returned PublishOutput's
   * prNumber will be this value.
   */
  existingPrNumber?: number;
  /**
   * True when a human explicitly initiated the publish from the UI (e.g. clicking
   * "Send to GitHub" on a previewed finding). The safety mode gate governs
   * autonomous agent behavior; a deliberate user click is a different trust act.
   * Honored only for `kind='issue'` and `kind='comment'` — never for `pr` or `review`,
   * which involve writing code or formal review state on the user's behalf.
   */
  manual?: boolean;
}

export type PublishOutput =
  | { kind: 'pr'; prNumber: number; htmlUrl: string }
  | { kind: 'issue'; issueNumber: number; htmlUrl: string }
  | { kind: 'comment'; issueNumber: number; commentId: number; htmlUrl: string }
  | { kind: 'review'; prNumber: number; reviewId: number }
  | { kind: 'noop'; reason: string };

const ACTION_PERMITTED: Record<SafetyMode, ReadonlySet<string>> = {
  observe: new Set(),
  issues: new Set(['create_issue', 'apply_label', 'post_comment']),
  prs: new Set([
    'create_issue',
    'apply_label',
    'post_comment',
    'commit',
    'push',
    'open_pr',
    'post_review',
  ]),
  automerge: new Set([
    'create_issue',
    'apply_label',
    'post_comment',
    'commit',
    'push',
    'open_pr',
    'post_review',
    'merge_pr',
  ]),
};

function ensureModeAllows(repo: Repo, action: string): void {
  if (!ACTION_PERMITTED[repo.mode].has(action)) {
    throw new ObeliskError(
      'MODE_TOO_LOW',
      `Action '${action}' is not allowed in safety mode '${repo.mode}'`,
      'Upgrade the repo safety mode in Settings to enable this action.',
    );
  }
}

const MANUAL_ALLOWED_ACTIONS: ReadonlySet<string> = new Set(['create_issue', 'post_comment']);

function checkAction(input: PublishInput, action: string): void {
  if (input.manual && MANUAL_ALLOWED_ACTIONS.has(action)) return;
  ensureModeAllows(input.repo, action);
}

/**
 * Dispatches a `PublishPlan` to GitHub. `noop` is a hatch for agents that
 * decided to do nothing. Every other kind is gated by `ensureModeAllows`
 * against the repo's safety mode.
 */
export async function publish(input: PublishInput): Promise<PublishOutput> {
  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before publishing.');
  }
  const [owner, repoName] = input.repo.githubFullName.split('/');
  if (!owner || !repoName) {
    throw new ObeliskError('INVALID_INPUT', `Bad full name: ${input.repo.githubFullName}`);
  }

  switch (input.plan.kind) {
    case 'noop':
      return { kind: 'noop', reason: input.plan.reason };

    case 'issue': {
      checkAction(input, 'create_issue');
      const created = await gh.issues.create({
        owner,
        repo: repoName,
        title: input.plan.title,
        body: input.plan.body,
        labels: input.plan.labels,
      });
      return {
        kind: 'issue',
        issueNumber: created.data.number,
        htmlUrl: created.data.html_url,
      };
    }

    case 'pr': {
      ensureModeAllows(input.repo, 'commit');
      ensureModeAllows(input.repo, 'push');
      ensureModeAllows(input.repo, 'open_pr');

      if (!input.worktreePath || !input.branch || !input.commitSubject) {
        throw new ObeliskError(
          'INVALID_INPUT',
          'PR plans require worktreePath, branch, and commitSubject.',
        );
      }

      const attr = await resolveAttribution(input.worktreePath, {
        mode: input.attributionMode ?? 'user',
        ...(input.attributionCustom?.name ? { customName: input.attributionCustom.name } : {}),
        ...(input.attributionCustom?.email ? { customEmail: input.attributionCustom.email } : {}),
      });
      const git = simpleGit(input.worktreePath);
      await applyGitConfig(git, attr);

      // Stage everything the runner produced + commit with the standardized
      // message shape (subject ends with [obelisk:<agent>], coauthor trailer).
      await git.add('--all');
      const commitMessage = renderCommitMessage({
        subject: input.commitSubject,
        agentName: input.agentName,
        ...(input.commitBody ? { body: input.commitBody } : {}),
        attribution: attr,
      });
      await git.commit(commitMessage, { '--no-verify': null });

      // Push the per-run branch to origin. For resume publishes the branch
      // already has an upstream tracking ref, so set-upstream is a no-op
      // (and harmless if re-set).
      await git.push(['--set-upstream', 'origin', input.branch]);

      // Resume publishes (CI-retry fix-up) skip `pulls.create` because the PR
      // already exists; the push above is enough — GitHub auto-attaches the
      // commit. We still mirror evidence + return the existing PR number.
      let prNumber: number;
      let htmlUrl: string;
      if (input.existingPrNumber) {
        prNumber = input.existingPrNumber;
        const existing = await gh.pulls
          .get({ owner, repo: repoName, pull_number: prNumber })
          .catch(() => null);
        htmlUrl = existing?.data.html_url ?? '';
      } else {
        const created = await gh.pulls.create({
          owner,
          repo: repoName,
          title: input.plan.title,
          body: input.plan.body,
          head: input.plan.head,
          base: input.plan.base,
          draft: false,
        });
        prNumber = created.data.number;
        htmlUrl = created.data.html_url;

        // Update the source issue's labels to reflect that a PR has been
        // opened against it:
        //   - Add `obelisk:in-progress` (idempotent — usually already
        //     applied at claim time).
        //   - REMOVE `obelisk:fix` so a sibling bug-fixer doesn't
        //     re-claim the same issue from the next backlog sync. The
        //     PR's `Fixes #N` line is what closes the loop now; the
        //     trigger label has done its job. If the user reopens the
        //     issue / closes the PR unmerged, they can re-apply
        //     `obelisk:fix` to retry.
        if (input.sourceIssueNumber) {
          await gh.issues
            .addLabels({
              owner,
              repo: repoName,
              issue_number: input.sourceIssueNumber,
              labels: [OBELISK_LABELS.inProgress],
            })
            .catch(() => undefined);
          await gh.issues
            .removeLabel({
              owner,
              repo: repoName,
              issue_number: input.sourceIssueNumber,
              name: OBELISK_LABELS.fix,
            })
            // 404 here means the label wasn't on the issue — fine.
            .catch(() => undefined);
        }
      }

      // Mirror artifacts into the repo so reviewers without Obelisk can see them.
      mirrorEvidenceToRepo({
        worktreePath: input.worktreePath,
        runId: input.runId,
        prNumber,
      });

      return {
        kind: 'pr',
        prNumber,
        htmlUrl,
      };
    }

    case 'review': {
      ensureModeAllows(input.repo, 'post_review');
      const prNumber = input.sourcePrNumber ?? input.plan.prNumber;
      const created = await gh.pulls.createReview({
        owner,
        repo: repoName,
        pull_number: prNumber,
        event: input.plan.event,
        body: input.plan.body,
      });
      return { kind: 'review', prNumber, reviewId: created.data.id };
    }

    case 'comment': {
      checkAction(input, 'post_comment');
      const created = await gh.issues.createComment({
        owner,
        repo: repoName,
        issue_number: input.plan.issueNumber,
        body: input.plan.body,
      });
      return {
        kind: 'comment',
        issueNumber: input.plan.issueNumber,
        commentId: created.data.id,
        htmlUrl: created.data.html_url,
      };
    }
  }
}

/**
 * Tear down the GitHub-side claim signals applied by `postClaimSignal` at
 * selectTask time: remove the `obelisk:in-progress` label AND remove the
 * connected user as an assignee. Called from the orchestrator's `finally`
 * regardless of run outcome. Best-effort — we never fail a run on cleanup.
 */
export async function clearClaimSignals(
  repo: Repo,
  issueNumber: number | undefined,
): Promise<void> {
  if (!issueNumber) return;
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  await gh.issues
    .removeLabel({ owner, repo: name, issue_number: issueNumber, name: OBELISK_LABELS.inProgress })
    .catch(() => undefined);

  const login = await getAuthedLogin().catch(() => null);
  if (login) {
    await gh.issues
      .removeAssignees({
        owner,
        repo: name,
        issue_number: issueNumber,
        assignees: [login],
      })
      .catch(() => undefined);
  }
}

/**
 * @deprecated Use `clearClaimSignals` — this is kept as a thin shim while
 * existing call sites migrate. Behaves identically (label + assignee) since
 * Phase 1.2.
 */
export const clearInProgressLabel = clearClaimSignals;
