import { simpleGit } from 'simple-git';
import { getGithub } from '../github/client';
import { ObeliskError } from '../../shared/errors';
import type { Repo, SafetyMode } from '../../shared/types';
import type { PublishPlan } from '../agents/types';
import { resolveAttribution, applyGitConfig, renderCommitMessage } from './attribution';
import { OBELISK_LABELS } from './labels';
import { mirrorEvidenceToRepo } from './artifact-mirror';

export interface PublishInput {
  repo: Repo;
  runId: string;
  worktreePath: string;
  branch: string;
  agentName: import('../../shared/types').AgentName;
  /** From repos.attribution_mode (Phase 9 surfaces this in Settings). */
  attributionMode?: 'user' | 'bot' | 'custom';
  attributionCustom?: { name?: string; email?: string };
  /** The plan from agent.interpretResult — what should be created on GitHub. */
  plan: PublishPlan;
  /** PR-body Summary line for the commit message. */
  commitSubject: string;
  /** Multi-line commit body. */
  commitBody?: string;
  /** Issue or PR number this run is tied to (for label lifecycle). */
  sourceIssueNumber?: number;
  /** PR number we're operating on (for review plans). */
  sourcePrNumber?: number;
}

export type PublishOutput =
  | { kind: 'pr'; prNumber: number; htmlUrl: string }
  | { kind: 'issue'; issueNumber: number; htmlUrl: string }
  | { kind: 'review'; prNumber: number; reviewId: number }
  | { kind: 'noop'; reason: string };

const ACTION_PERMITTED: Record<SafetyMode, ReadonlySet<string>> = {
  observe: new Set(),
  issues: new Set(['create_issue', 'apply_label']),
  prs: new Set(['create_issue', 'apply_label', 'commit', 'push', 'open_pr', 'post_review']),
  automerge: new Set([
    'create_issue',
    'apply_label',
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

/**
 * Phase 4 publisher. Three plans are supported end-to-end (PR / issue /
 * review); 'noop' is a hatch for agents that decided to do nothing.
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
      ensureModeAllows(input.repo, 'create_issue');
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

      // Push the per-run branch to origin.
      await git.push(['--set-upstream', 'origin', input.branch]);

      // Open the draft PR.
      const created = await gh.pulls.create({
        owner,
        repo: repoName,
        title: input.plan.title,
        body: input.plan.body,
        head: input.plan.head,
        base: input.plan.base,
        draft: input.plan.draft,
      });

      // Apply in-progress label to the source issue, if any.
      if (input.sourceIssueNumber) {
        await gh.issues.addLabels({
          owner,
          repo: repoName,
          issue_number: input.sourceIssueNumber,
          labels: [OBELISK_LABELS.inProgress],
        });
      }

      // Mirror artifacts into the repo so reviewers without Obelisk can see them.
      mirrorEvidenceToRepo({
        worktreePath: input.worktreePath,
        runId: input.runId,
        prNumber: created.data.number,
      });

      return {
        kind: 'pr',
        prNumber: created.data.number,
        htmlUrl: created.data.html_url,
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
  }
}

/**
 * Remove the `obelisk:in-progress` label after a run finishes (any state).
 * Best-effort — we never fail a run on label cleanup.
 */
export async function clearInProgressLabel(
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
}
