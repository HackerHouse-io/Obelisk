import { nextAvailable, getBacklogItem } from '../../db/backlog';
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
  // Walk the backlog from the top. The first allowlisted, non-in-flight bug
  // wins. Items skipped by the allowlist gate are audit-logged and left alone.
  let cursor = nextAvailable(input.repo.id, 'bug');
  while (cursor !== null) {
    const author = await fetchIssueAuthor(input.repo.githubFullName, cursor.githubIssue);
    if (author === null) {
      // Manual backlog item with no GitHub issue — skip allowlist (no actor).
      // (PRD says manual entries are user-driven; the user is by definition trusted.)
      return wrap(cursor);
    }
    const allow = checkActorAllowlist({
      repoId: input.repo.id,
      login: author,
      source: cursor.githubIssue ? `issue#${cursor.githubIssue}` : `backlog#${cursor.id}`,
    });
    if (allow.ok) return wrap(cursor);

    // Try the next available bug in the queue.
    cursor = nextAvailableExcluding(input.repo.id, [cursor.id]);
  }
  return null;
}

function wrap(item: ReturnType<typeof getBacklogItem> & {}): SelectedTask {
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

/**
 * Helper that walks the backlog skipping a set of ids — used when the
 * allowlist gate rejects the head of the queue and we need to keep looking.
 */
function nextAvailableExcluding(
  repoId: string,
  exclude: string[],
): ReturnType<typeof nextAvailable> {
  // Phase 4 keeps this simple: re-fetch + filter. The full query lives in
  // db/backlog.ts; we layer the exclusion here so db/backlog stays generic.
  let cursor = nextAvailable(repoId, 'bug');
  const skip = new Set(exclude);
  while (cursor !== null && skip.has(cursor.id)) {
    skip.add(cursor.id);
    cursor = nextAvailable(repoId, 'bug');
    // The DB query doesn't take a "skip" arg, so once nextAvailable returns
    // the same head, we're stuck. Real fix: add exclude to the query in
    // Phase 5 when QA Hunter starts producing many entries. For Phase 4 we
    // pessimistically return null after one pass.
    return null;
  }
  return cursor;
}

function oneLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function prefixWithFix(subject: string): string {
  if (/^fix\b/i.test(subject)) return subject;
  return `fix: ${subject}`;
}
