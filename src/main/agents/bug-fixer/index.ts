import { ulid } from 'ulid';
import {
  claimNextBacklogItem,
  unlockBacklogItem,
  deleteBacklogGhIssue,
  getBacklogItem,
  listBacklog,
  releaseStaleBacklogLocks,
} from '../../db/backlog';
import { parseBacklogTaskRef } from '../../../shared/task-refs';
import { forcedBacklogItem } from '../lib/forced-backlog';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { fetchIssueContext } from '../lib/fetch-issue-author';
import { postClaimSignal } from '../lib/claim-on-github';
import { isClaimedByAnotherInstall } from '../lib/cross-install-guard';
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

/**
 * Issue labels that mark a bug as not-yet-actionable: the premise still needs
 * human confirmation, or it's an open question / blocked. Auto-ticks skip
 * these so the agent never spawns a run that's destined to end in REPRO_FAILED.
 * Compared case-insensitively. A forced (manual, clarified) retry bypasses this.
 */
const NOT_READY_LABELS = new Set(['needs-spec-confirmation', 'question', 'blocked']);

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
    };
  },
};

/* ---------- internals ---------- */

async function selectTaskForBugFixer(input: SelectTaskInput): Promise<SelectedTask | null> {
  // Forced retry (manual Retry button / infra auto-retry): re-target the exact
  // backlog item the failed run worked on, bypassing the sweep's filters.
  const forcedRef = input.forceTask ? parseBacklogTaskRef(input.taskId ?? null) : null;
  if (forcedRef) {
    const item = forcedBacklogItem({
      repoId: input.repo.id,
      kind: 'bug',
      ref: forcedRef,
      placeholder: `pending:${ulid()}`,
    });
    if (!item) return null;
    if (item.githubIssue) {
      await postClaimSignal({
        repo: input.repo,
        issueNumber: item.githubIssue,
        source: `issue#${item.githubIssue}`,
      }).catch(() => undefined);
    }
    return wrap(item);
  }

  // Stale-lock + sync pre-pass on manual Run-now. Two failure modes
  // we used to surface as the misleading "No claimable issue right now":
  //
  //   - Orphan locks from a crashed run (in_progress_run set, but the
  //     run row is terminal or missing) hide rows from claimNextBacklogItem
  //     forever. Release them first so the loop can see them.
  //   - Stale local backlog: a freshly-labeled GitHub issue won't appear
  //     until the next 5-min sync sweep. The previous `haveBugs` short-
  //     circuit skipped the inline sync whenever any unlocked row existed
  //     locally, so a stale row could mask new GH issues. Always sync on
  //     manual triggers — the cost is one (mostly-ETag-cached) Octokit
  //     call and the benefit is Run-now always reflects current GH state.
  //
  // Scheduled / webhook triggers stay on the periodic 5-min sweep path
  // and skip both the cleanup and the inline sync — the cron tick handles
  // them on its own cadence and we don't want to amplify quota use.
  let staleLocksReleased = 0;
  if (input.trigger === 'manual') {
    staleLocksReleased = releaseStaleBacklogLocks(input.repo.id);
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

  // Atomic claim — guarantees two parallel Bug Fixers pick different rows.
  // The placeholder token holds the lock until the orchestrator attaches the
  // real run id post-createRun.
  const placeholder = `pending:${ulid()}`;
  const tried = new Set<string>();
  let closed = 0;
  let locked = 0;
  let triggerGone = 0;
  let crossInstall = 0;
  let allowlistDenied = 0;
  let needsSpec = 0;

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

    // Trigger-label-gone guard. The publisher removes `obelisk:fix` from
    // the issue right after opening a PR (so the next sync doesn't
    // re-enroll it). If the local backlog row outlived that label
    // removal — e.g. a previous run finished moments ago and the periodic
    // reaper hasn't fired yet, or a user manually unenrolled the issue —
    // this row is stale. Drop it so a back-to-back Run-now click can't
    // re-pick the same issue and produce a duplicate PR.
    if (!ctx.labels.includes(OBELISK_LABELS.fix)) {
      unlockBacklogItem(item.id);
      deleteBacklogGhIssue(input.repo.id, item.githubIssue);
      triggerGone += 1;
      continue;
    }

    // Not-ready guard. An issue still awaiting human confirmation
    // (`needs-spec-confirmation`) or flagged as a `question`/`blocked` is not a
    // confirmed, actionable bug — dispatching the agent at it just burns a run
    // that ends in REPRO_FAILED (exactly issue #52). Skip it here so auto-ticks
    // never spawn a doomed run; the user can still force it via a clarified
    // Retry (the forced path above bypasses this filtering). Keep the lock
    // released but the row in the backlog so it returns once the label clears.
    if (ctx.labels.some((l) => NOT_READY_LABELS.has(l.toLowerCase()))) {
      unlockBacklogItem(item.id);
      needsSpec += 1;
      continue;
    }

    // Cross-installation guard: skip issues another Obelisk install
    // already claimed (label + self-assignee signature). The reaper will
    // clear a genuinely orphaned signal after 24h, at which point the
    // issue becomes claimable again.
    const authedLogin = await getAuthedLogin().catch(() => null);
    if (
      isClaimedByAnotherInstall({
        labels: ctx.labels,
        assignees: ctx.assignees,
        connectedLogin: authedLogin,
        source: `issue#${item.githubIssue}`,
      })
    ) {
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
  const allBugs = listBacklog(input.repo.id).filter((b) => b.kind === 'bug');
  const totalBugs = allBugs.length;
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
  if (triggerGone > 0)
    reasons.push(`${triggerGone} no longer labeled \`obelisk:fix\` (PR already opened?)`);
  if (crossInstall > 0) reasons.push(`${crossInstall} already claimed by another Obelisk install`);
  if (allowlistDenied > 0)
    reasons.push(`${allowlistDenied} authored by users not on the allowlist`);
  if (needsSpec > 0)
    reasons.push(
      `${needsSpec} awaiting spec confirmation (labeled needs-spec-confirmation/question/blocked)`,
    );
  // Diagnostic fallback — reached when tried.size === 0 (every local row
  // is locked by a live run) or every iteration silently skipped via
  // the !ctx path (issue removed from GitHub between sync and fetch).
  // Either way, the old "No claimable issue right now" was uninformative;
  // tell the user what we actually saw.
  const inFlight = allBugs.filter((b) => b.inProgressRun !== null).length;
  let message: string;
  if (reasons.length > 0) {
    message =
      `All ${tried.size} candidate issue${tried.size === 1 ? '' : 's'} ` +
      `${tried.size === 1 ? 'was' : 'were'} filtered out: ${reasons.join(', ')}.`;
  } else if (inFlight > 0 && inFlight === totalBugs) {
    message =
      `All ${totalBugs} \`obelisk:fix\` issue${totalBugs === 1 ? '' : 's'} in the local backlog ` +
      `${totalBugs === 1 ? 'is' : 'are'} already in flight (held by another run).`;
  } else {
    message =
      `Local backlog has ${totalBugs} \`obelisk:fix\` issue${totalBugs === 1 ? '' : 's'}` +
      `${inFlight > 0 ? ` (${inFlight} in flight)` : ''}, but none could be claimed.`;
  }
  const hint =
    allowlistDenied > 0
      ? 'Add the issue authors via the Allowlist settings.'
      : inFlight > 0 && inFlight === totalBugs
        ? 'Wait for a run to finish, or label more GitHub issues with `obelisk:fix`.'
        : staleLocksReleased > 0
          ? `Cleared ${staleLocksReleased} stale lock${staleLocksReleased === 1 ? '' : 's'} from a previous run — try Run now again.`
          : 'Open the Backlog screen to inspect the rows, or label more GitHub issues with `obelisk:fix`.';
  throw new ObeliskError('BACKLOG_ALL_FILTERED', message, hint);
}

function wrap(item: NonNullable<ReturnType<typeof getBacklogItem>>): SelectedTask {
  return {
    backlogItem: item,
    task: {
      ref: item.githubIssue ? `issue#${item.githubIssue}` : `backlog#${item.id}`,
      kind: 'bug',
      summary: item.title,
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

/* ---------- structured-report parsing ---------- */

const BUG_FIX_REPORT_RE = /BEGIN_BUG_FIX_REPORT\s*([\s\S]*?)\s*END_BUG_FIX_REPORT/;

export interface BugFixTestCase {
  name: string;
  asserts: string;
}

export interface BugFixTestPlan {
  new_tests_file?: string;
  cases?: BugFixTestCase[];
  manual_verification?: string;
}

export interface BugFixReport {
  summary: string;
  root_cause: string;
  /** 1–4 imperative bullets describing what changed. */
  fix: string[];
  /** Optional structured test plan — present for any code-touching fix. */
  test_plan?: BugFixTestPlan;
  /** Optional reviewer-actionable notes (merge resolution, incidental cleanup). */
  notes?: string[];
}

/**
 * Pull the agent's structured report out of the runner's reasoning blob.
 * Returns null when the block is missing or malformed; the caller falls
 * back to the legacy reasoning-dump body shape.
 */
export function parseBugFixReport(reasoning: string): BugFixReport | null {
  const match = reasoning.match(BUG_FIX_REPORT_RE);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    return normalizeBugFixReport(parsed);
  } catch {
    return null;
  }
}

function normalizeBugFixReport(v: unknown): BugFixReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['summary'] !== 'string') return null;
  if (typeof o['root_cause'] !== 'string') return null;
  if (!Array.isArray(o['fix'])) return null;
  const fix = (o['fix'] as unknown[]).filter((s): s is string => typeof s === 'string');
  if (fix.length === 0) return null;

  const out: BugFixReport = {
    summary: o['summary'],
    root_cause: o['root_cause'],
    fix,
  };

  // Optional test_plan — accept partial shapes (cases-only, manual-only, etc.).
  if (o['test_plan'] && typeof o['test_plan'] === 'object') {
    const tp = o['test_plan'] as Record<string, unknown>;
    const plan: BugFixTestPlan = {};
    if (typeof tp['new_tests_file'] === 'string' && tp['new_tests_file'].length > 0) {
      plan.new_tests_file = tp['new_tests_file'];
    }
    if (Array.isArray(tp['cases'])) {
      const cases = (tp['cases'] as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          name: typeof c['name'] === 'string' ? c['name'] : '',
          asserts: typeof c['asserts'] === 'string' ? c['asserts'] : '',
        }))
        .filter((c) => c.name.length > 0);
      if (cases.length > 0) plan.cases = cases;
    }
    if (
      typeof tp['manual_verification'] === 'string' &&
      tp['manual_verification'].trim().length > 0
    ) {
      plan.manual_verification = tp['manual_verification'].trim();
    }
    if (Object.keys(plan).length > 0) out.test_plan = plan;
  }

  if (Array.isArray(o['notes'])) {
    const notes = (o['notes'] as unknown[])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (notes.length > 0) out.notes = notes;
  }

  return out;
}

/**
 * Strip `issue#` prefix from the orchestrator's task ref, returning the
 * raw issue number. Used by the PR-body renderer to emit `Fixes #N.`
 * which auto-closes the GitHub issue when the PR merges.
 */
export function issueNumberFromTaskRef(taskRef: string): number | null {
  const match = taskRef.match(/^issue#(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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
