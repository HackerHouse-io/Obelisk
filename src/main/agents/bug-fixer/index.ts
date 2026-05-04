import { ulid } from 'ulid';
import { claimNextBacklogItem, unlockBacklogItem, getBacklogItem } from '../../db/backlog';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { fetchIssueAuthor } from '../lib/fetch-issue-author';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const bugFixerHandler: AgentHandler = {
  name: 'bug-fixer',
  multiInstance: true,
  addAnotherExplainer:
    'Each instance picks a different bug per tick. Adding more drains the backlog faster.',
  skipsEvidenceGate: false,
  producesPatch: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    return selectTaskForBugFixer(input);
  },

  interpretResult(input: InterpretResultInput): PublishPlan {
    const { task, runResult, repo } = input;
    const summary = oneLine(runResult.reasoning) || `Fix ${task.ref}`;
    return {
      kind: 'pr',
      title: prefixWithFix(summary),
      // Body is filled in by the orchestrator using evidence/pr-body.ts
      body: '',
      head: '', // filled in by orchestrator (= worktree branch)
      base: repo.defaultBranch,
      draft: true,
    };
  },
};

/* ---------- internals ---------- */

async function selectTaskForBugFixer(input: SelectTaskInput): Promise<SelectedTask | null> {
  // Atomic claim — guarantees two parallel Bug Fixers pick different rows.
  // The placeholder token holds the lock until the orchestrator attaches the
  // real run id post-createRun.
  const placeholder = `pending:${ulid()}`;
  const tried = new Set<string>();
  for (let attempts = 0; attempts < 32; attempts++) {
    const item = claimNextBacklogItem(input.repo.id, 'bug', placeholder);
    if (!item) return null;
    if (tried.has(item.id)) {
      // Defensive: the same item came back, something's off — release and stop.
      unlockBacklogItem(item.id);
      return null;
    }
    tried.add(item.id);

    const author = await fetchIssueAuthor(input.repo.githubFullName, item.githubIssue);
    if (author === null) {
      // Manual backlog item with no GitHub issue — skip allowlist (no actor).
      return wrap(item);
    }
    const allow = checkActorAllowlist({
      repoId: input.repo.id,
      login: author,
      source: item.githubIssue ? `issue#${item.githubIssue}` : `backlog#${item.id}`,
    });
    if (allow.ok) return wrap(item);

    // Allowlist denied — release and try the next candidate.
    unlockBacklogItem(item.id);
  }
  return null;
}

function wrap(item: NonNullable<ReturnType<typeof getBacklogItem>>): SelectedTask {
  return {
    backlogItem: item,
    task: {
      ref: item.githubIssue ? `issue#${item.githubIssue}` : `backlog#${item.id}`,
      kind: 'bug',
      context: item.title,
      ...(item.githubIssue ? { githubNumber: item.githubIssue } : {}),
    },
    runnerOverride: item.runnerOverride,
  };
}

function oneLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function prefixWithFix(subject: string): string {
  if (/^fix\b/i.test(subject)) return subject;
  return `fix: ${subject}`;
}
