import { ulid } from 'ulid';
import {
  claimNextBacklogItem,
  unlockBacklogItem,
  deleteBacklogGhIssue,
  getBacklogItem,
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
    const { task, repo } = input;
    // The PR title is derived from the GitHub issue title (already on
    // `task.context` from selectTask's wrap()). Earlier versions tried
    // `oneLine(runResult.reasoning)` — but Claude Code's stream-of-
    // consciousness output has no early newlines, so `oneLine` returned
    // the entire monologue and produced PR titles hundreds of words
    // long. The issue title is the user's own short, factual sentence;
    // it's the right thing to ship.
    return {
      kind: 'pr',
      title: buildPrTitle(task.context, task.ref),
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
  // Make the FIRST Run-now click work even if the periodic backlog sync
  // (every ~2 min) hasn't fired since the user connected the repo. Skip
  // the inline sync for scheduled triggers — the cron tick already runs
  // sync alongside dispatch, so doing it again wastes API quota.
  if (input.trigger === 'manual') {
    const haveBugs = listBacklog(input.repo.id).some(
      (b) => b.kind === 'bug' && b.inProgressRun === null,
    );
    if (!haveBugs) {
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

  // Atomic claim — guarantees two parallel Bug Fixers pick different rows.
  // The placeholder token holds the lock until the orchestrator attaches the
  // real run id post-createRun.
  const placeholder = `pending:${ulid()}`;
  const tried = new Set<string>();
  let closed = 0;
  let locked = 0;
  let crossInstall = 0;
  let allowlistDenied = 0;

  for (let attempts = 0; attempts < 32; attempts++) {
    const item = claimNextBacklogItem(input.repo.id, 'bug', placeholder);
    if (!item) break;
    if (tried.has(item.id)) {
      // Defensive: the same item came back, something's off — release and stop.
      unlockBacklogItem(item.id);
      break;
    }
    tried.add(item.id);

    if (!item.githubIssue) {
      // Manual backlog item with no GitHub issue — skip allowlist (no actor).
      return wrap(item);
    }

    // One API call to fetch author + state + locked. Lets us short-circuit
    // on closed/locked rows without a second round-trip.
    const ctx = await fetchIssueContext(input.repo.githubFullName, item.githubIssue);
    if (!ctx) {
      // No context returned (deleted user, malformed full name) — drop the
      // row so we don't loop on it.
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

    // Cross-installation guard: another Obelisk install (or our own
    // crashed prior run) may already be working this issue. The signature
    // is "obelisk:in-progress label present AND the connected user is an
    // assignee". We skip and unlock — the claim-signal reaper will clear
    // a genuinely orphaned signal after 24h, at which point this issue
    // becomes claimable again.
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
      // Manual trigger = the user explicitly clicked Run now → they're
      // vouching for the action. Skip the allowlist gate but log it so
      // there's still a paper trail. Scheduled / webhook triggers always
      // pay the gate's cost (it's the primary defense against drive-by
      // prompt-injection on public repos).
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

    // Apply the GitHub-side claim signal (assignee + label) before returning.
    // Best-effort and audit-logged; never aborts the run.
    await postClaimSignal({
      repo: input.repo,
      issueNumber: item.githubIssue,
      source: `issue#${item.githubIssue}`,
    });

    return wrap(item);
  }

  // Categorized empty-state errors are surfaced through to the renderer
  // when the user explicitly clicked Run now — they want a clear
  // explanation. Scheduled / webhook triggers fall back to a quiet null
  // (the orchestrator converts that to the "nothing to do" sentinel) so
  // the cron tick doesn't spam scheduler_error rows every minute on a
  // genuinely-empty backlog.
  const totalBugs = listBacklog(input.repo.id).filter((b) => b.kind === 'bug').length;
  if (tried.size === 0 && totalBugs === 0) {
    if (input.trigger !== 'manual') return null;
    throw new ObeliskError(
      'BACKLOG_EMPTY',
      'No `obelisk:fix` issues found for this repo.',
      'Apply the `obelisk:fix` label to a GitHub issue (and optionally `P0` / `P1` / `P2` for priority), or add a manual backlog item from the Backlog screen.',
    );
  }

  if (input.trigger !== 'manual') return null;

  const reasons: string[] = [];
  if (closed > 0) reasons.push(`${closed} closed`);
  if (locked > 0) reasons.push(`${locked} locked`);
  if (crossInstall > 0) reasons.push(`${crossInstall} already claimed by another Obelisk install`);
  if (allowlistDenied > 0)
    reasons.push(`${allowlistDenied} authored by users not on the allowlist`);
  throw new ObeliskError(
    'BACKLOG_ALL_FILTERED',
    reasons.length > 0
      ? `All ${tried.size} candidate issue${tried.size === 1 ? '' : 's'} ` +
          `${tried.size === 1 ? 'was' : 'were'} filtered out: ${reasons.join(', ')}.`
      : 'No claimable issue right now.',
    allowlistDenied > 0
      ? 'Add the issue authors via the Allowlist settings.'
      : 'Try again after a sync cycle, or file a manual backlog item.',
  );
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

/** Conventional-commit cap so the PR title stays readable in the GitHub UI. */
const MAX_PR_TITLE_LENGTH = 72;

/**
 * Build a sane `fix: <subject>` PR title from the GitHub issue title.
 * Strips common bracketed prefixes (e.g. `[bug]`, `[BUG]`), truncates
 * to MAX_PR_TITLE_LENGTH characters, and falls back to the task ref if
 * the issue title is empty.
 *
 * Exported for unit testing — the title is the most-visible artifact a
 * Bug Fixer ships, so its derivation needs explicit assertions.
 */
export function buildPrTitle(issueTitle: string | undefined, taskRef: string): string {
  const subject = sanitizeIssueTitle(issueTitle ?? '') || `Fix ${taskRef}`;
  return prefixWithFix(truncateForPrTitle(subject, MAX_PR_TITLE_LENGTH));
}

function sanitizeIssueTitle(raw: string): string {
  return (
    raw
      .replace(/\r?\n/g, ' ')
      // Strip leading "[bug]" / "[BUG]" / "[Feature]" bracketed prefixes
      // (any number of them). They duplicate the `fix:` prefix we add.
      .replace(/^(\s*\[[^\]]+\]\s*)+/g, '')
      .trim()
  );
}

function prefixWithFix(subject: string): string {
  if (/^fix\b/i.test(subject)) return subject;
  return `fix: ${subject}`;
}

/** Cut to maxLen at a word boundary when possible, then append a single ellipsis. */
function truncateForPrTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const head = text.slice(0, maxLen - 1);
  const lastSpace = head.lastIndexOf(' ');
  // Keep at least 24 chars even if there's no good word break.
  const cut = lastSpace > 24 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}
