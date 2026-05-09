import { ulid } from 'ulid';
import {
  claimNextBacklogItem,
  unlockBacklogItem,
  deleteBacklogGhIssue,
  listBacklog,
} from '../../db/backlog';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { fetchIssueContext } from '../lib/fetch-issue-author';
import { postClaimSignal } from '../lib/claim-on-github';
import { getAuthedLogin } from '../../auth/token-store';
import { OBELISK_LABELS } from '../../publisher/labels';
import { appendAudit } from '../../logger/audit';
import { syncBacklogForRepo } from '../../scheduler/backlog-sync';
import { ObeliskError } from '../../../shared/errors';
import { registerArtifactFromPath } from '../lib/register-artifact';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const featureBuilderHandler: AgentHandler = {
  name: 'feature-builder',
  multiInstance: true,
  addAnotherExplainer:
    'Each instance ships a different feature in parallel — distinct backlog rows, no overlap.',
  // Feature Builder ships PRs and MUST go through the Evidence Pack gate.
  skipsEvidenceGate: false,
  producesPatch: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // Inline backlog sync for manual triggers when the local table has
    // no claimable feature rows. Mirrors the bug-fixer fix for the same
    // "Run now → nothing to do" failure mode.
    if (input.trigger === 'manual') {
      const haveFeatures = listBacklog(input.repo.id).some(
        (b) => b.kind === 'feature' && b.inProgressRun === null,
      );
      if (!haveFeatures) {
        await syncBacklogForRepo(input.repo.id).catch((e: unknown) => {
          appendAudit({
            runId: 'system',
            kind: 'inline_backlog_sync_failed',
            payload: {
              repo: input.repo.githubFullName,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        });
      }
    }

    // Atomic claim so two parallel instances pick different feature rows.
    const placeholder = `pending:${ulid()}`;
    const tried = new Set<string>();
    let closed = 0;
    let locked = 0;
    let crossInstall = 0;
    let allowlistDenied = 0;

    for (let attempts = 0; attempts < 32; attempts++) {
      const item = claimNextBacklogItem(input.repo.id, 'feature', placeholder);
      if (!item) break;
      if (tried.has(item.id)) {
        unlockBacklogItem(item.id);
        break;
      }
      tried.add(item.id);

      if (item.githubIssue) {
        const ctx = await fetchIssueContext(input.repo.githubFullName, item.githubIssue);
        if (!ctx) {
          unlockBacklogItem(item.id);
          deleteBacklogGhIssue(input.repo.id, item.githubIssue);
          continue;
        }
        if (ctx.state === 'closed') {
          unlockBacklogItem(item.id);
          deleteBacklogGhIssue(input.repo.id, item.githubIssue);
          closed += 1;
          continue;
        }
        if (ctx.locked) {
          unlockBacklogItem(item.id);
          deleteBacklogGhIssue(input.repo.id, item.githubIssue);
          locked += 1;
          continue;
        }
        // Cross-installation guard — see bug-fixer for the rationale.
        const authedLogin = await getAuthedLogin().catch(() => null);
        if (
          ctx.labels.includes(OBELISK_LABELS.inProgress) &&
          authedLogin &&
          ctx.assignees.includes(authedLogin)
        ) {
          appendAudit({
            runId: 'system',
            kind: 'cross_install_skipped',
            payload: {
              source: `issue#${item.githubIssue}`,
              login: authedLogin,
              assignees: ctx.assignees,
            },
          });
          unlockBacklogItem(item.id);
          crossInstall += 1;
          continue;
        }
        if (ctx.author) {
          if (input.trigger === 'manual') {
            appendAudit({
              runId: 'system',
              kind: 'actor_skipped_manual_override',
              payload: { source: `issue#${item.githubIssue}`, login: ctx.author },
            });
          } else {
            const allow = checkActorAllowlist({
              repoId: input.repo.id,
              login: ctx.author,
              source: `issue#${item.githubIssue}`,
            });
            if (!allow.ok) {
              unlockBacklogItem(item.id);
              allowlistDenied += 1;
              continue;
            }
          }
        }

        await postClaimSignal({
          repo: input.repo,
          issueNumber: item.githubIssue,
          source: `issue#${item.githubIssue}`,
        });
      }

      return {
        backlogItem: item,
        task: {
          ref: item.githubIssue ? `issue#${item.githubIssue}` : `backlog#${item.id}`,
          kind: 'feature',
          context: item.title,
          ...(item.githubIssue ? { githubNumber: item.githubIssue } : {}),
        },
        runnerOverride: item.runnerOverride,
      };
    }

    // Same categorized-error path as bug-fixer: only throw on manual
    // triggers (so the user gets an actionable hint); return null on
    // scheduled triggers so cron stays quiet on an empty backlog.
    const totalFeatures = listBacklog(input.repo.id).filter((b) => b.kind === 'feature').length;
    if (tried.size === 0 && totalFeatures === 0) {
      if (input.trigger !== 'manual') return null;
      throw new ObeliskError(
        'BACKLOG_EMPTY',
        'No `obelisk:feature` issues found for this repo.',
        'Apply the `obelisk:feature` label to a GitHub issue, or add a manual backlog item from the Backlog screen.',
      );
    }
    if (input.trigger !== 'manual') return null;
    const reasons: string[] = [];
    if (closed > 0) reasons.push(`${closed} closed`);
    if (locked > 0) reasons.push(`${locked} locked`);
    if (crossInstall > 0) reasons.push(`${crossInstall} claimed by another install`);
    if (allowlistDenied > 0) reasons.push(`${allowlistDenied} not on allowlist`);
    throw new ObeliskError(
      'BACKLOG_ALL_FILTERED',
      reasons.length > 0
        ? `All ${tried.size} candidate feature${tried.size === 1 ? '' : 's'} ` +
            `${tried.size === 1 ? 'was' : 'were'} filtered: ${reasons.join(', ')}.`
        : 'No claimable feature request right now.',
      allowlistDenied > 0
        ? 'Add the issue authors via the Allowlist settings.'
        : 'Try again after a sync cycle, or file a manual backlog item.',
    );
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const out = parseFeatureOutput(input.runResult.reasoning);
    if (!out) return [];

    registerArtifactFromPath({
      rel: out.screenshot_path,
      repoPath: input.repo.localPath,
      runId: input.runId,
      kind: 'screenshot',
    });
    registerArtifactFromPath({
      rel: out.server_log_path,
      repoPath: input.repo.localPath,
      runId: input.runId,
      kind: 'log',
    });

    const plans: PublishPlan[] = [];
    const issueNumber = input.task.githubNumber;

    if (issueNumber && out.spec.trim()) {
      plans.push({
        kind: 'comment',
        issueNumber,
        body: renderAgentComment(
          '## Spec (Feature Builder · DEFINE)',
          out.spec,
          '_Posted by Obelisk on behalf of Feature Builder. Edit the spec in this thread before merging the PR if anything is off._',
        ),
      });
    }
    if (issueNumber && out.plan.trim()) {
      plans.push({
        kind: 'comment',
        issueNumber,
        body: renderAgentComment(
          '## Plan (Feature Builder · PLAN)',
          out.plan,
          '_Posted by Obelisk on behalf of Feature Builder._',
        ),
      });
    }

    plans.push({
      kind: 'pr',
      title: out.pr_title,
      // Placeholder: the orchestrator overwrites `body` with the rendered
      // Evidence Pack section before publishing.
      body: out.pr_summary,
      head: '',
      base: input.repo.defaultBranch,
    });

    return plans;
  },
};

/* ---------- output parsing ---------- */

// Wire format is snake_case for LLM ergonomics; our other code is camelCase.
interface FeatureOutput {
  spec: string;
  plan: string;
  pr_title: string;
  pr_summary: string;
  screenshot_path?: string;
  server_log_path?: string;
}

const FEATURE_OUTPUT_RE = /BEGIN_FEATURE_OUTPUT\s*([\s\S]*?)\s*END_FEATURE_OUTPUT/;

export function parseFeatureOutput(stdout: string): FeatureOutput | null {
  const match = stdout.match(FEATURE_OUTPUT_RE);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    return isFeatureOutput(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFeatureOutput(v: unknown): v is FeatureOutput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['spec'] === 'string' &&
    typeof o['plan'] === 'string' &&
    typeof o['pr_title'] === 'string' &&
    o['pr_title'].length > 0 &&
    typeof o['pr_summary'] === 'string'
  );
}

/* ---------- comment bodies ---------- */

function renderAgentComment(heading: string, body: string, footer: string): string {
  return [heading, '', body.trim(), '', footer].join('\n');
}
