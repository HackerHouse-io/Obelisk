import { nextAvailable } from '../../db/backlog';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { fetchIssueAuthor } from '../lib/fetch-issue-author';
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
  // Feature Builder ships PRs and MUST go through the Evidence Pack gate.
  skipsEvidenceGate: false,
  producesPatch: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    const item = nextAvailable(input.repo.id, 'feature');
    if (!item) return null;

    if (item.githubIssue) {
      const author = await fetchIssueAuthor(input.repo.githubFullName, item.githubIssue);
      if (author) {
        const allow = checkActorAllowlist({
          repoId: input.repo.id,
          login: author,
          source: `issue#${item.githubIssue}`,
        });
        if (!allow.ok) return null;
      }
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
      draft: true,
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
