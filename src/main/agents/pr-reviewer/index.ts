import { getDb } from '../../db';
import { getGithub } from '../../github/client';
import { loadGitHubToken, getAuthedLogin } from '../../auth/token-store';
import { ObeliskError } from '../../../shared/errors';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { postClaimSignal } from '../lib/claim-on-github';
import {
  isClaimedByAnotherInstall,
  normalizeGithubAssignees,
  normalizeGithubLabels,
} from '../lib/cross-install-guard';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { parsePrTaskRef } from '../../../shared/task-refs';
import { crossCheckEvidence, isEvidenceComplete } from './evidence-cross-check';
import {
  claimPrReview,
  failedAttemptCount,
  wasReviewed as wasReviewedAtSha,
} from '../../db/pr-review-claims';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

/**
 * After this many completed `pr-reviewer` runs against the same PR (across
 * all SHAs), stop attempting fix-up commits and fall back to review-only.
 * The reviewer's own commits change the head SHA, which means a "new"
 * (PR, SHA) tuple is claimable on the next sweep — without a cap, the
 * agent could spend forever fixing-then-fixing-its-fixes.
 */
const REVIEW_LIVELOCK_CAP = 3;

/**
 * After this many FAILED reviews of the same (PR, SHA), stop re-claiming it.
 * A failed/timed-out review releases its claim with `result='failed'`, which
 * the dedup checks (`wasReviewedAtSha`, `alreadyReviewed`) intentionally don't
 * count — they only block on a completed review. Without this cap a PR whose
 * review reliably fails (e.g. a 30-min Xcode suite that still overruns, or a
 * runner that crashes on that diff) gets re-reviewed on every 30s scheduler
 * tick forever, burning a full run each time. The cap bounds the damage; a new
 * commit (new SHA) resets the count to zero so real progress is always retried.
 */
const FAILED_REVIEW_ATTEMPT_CAP = 2;

/**
 * Branch-name convention for Obelisk-opened PRs (Bug Fixer / Feature
 * Builder). Used to gate fix mode — the reviewer never pushes commits
 * onto a human-authored PR's branch.
 */
const OBELISK_BRANCH_PREFIX = 'obelisk/';

/**
 * The structured-output fence the agent emits. The orchestrator's
 * `optionalPatch` coercion uses this to distinguish a clean review run
 * (the agent ran, emitted findings, didn't touch files) from a silent
 * runner crash (no diff, no output). Exported so `orchestrator/run.ts`
 * doesn't have to know the agent's wire format.
 */
export const PR_REVIEW_MARKER = 'BEGIN_PR_REVIEW';

export const prReviewerHandler: AgentHandler = {
  name: 'pr-reviewer',
  multiInstance: true,
  addAnotherExplainer:
    'Each instance reviews a different open PR. The same PR is never reviewed twice at the same SHA.',
  // The PR's existing Evidence section was produced by the original
  // agent; the reviewer's optional fix-up commits append to that PR
  // and don't open a new one, so the Evidence gate doesn't apply.
  skipsEvidenceGate: true,
  // Hybrid: in fix mode the runner CAN commit fixes onto the PR's
  // branch; in review-only mode it produces no patch. The orchestrator
  // treats `no_changes` as success when structured review output is
  // present (see `optionalPatch` in agents/types.ts).
  producesPatch: true,
  optionalPatch: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    const gh = await getGithub();
    if (!gh) {
      throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before running agents.');
    }
    const isManual = input.trigger === 'manual';
    const [owner, name] = input.repo.githubFullName.split('/');
    if (!owner || !name) {
      if (!isManual) return null;
      throw new ObeliskError(
        'INVALID_INPUT',
        `Repo "${input.repo.githubFullName}" is not a valid GitHub <owner>/<name>.`,
        'Reconnect the repo from the Repos screen so its GitHub name is set correctly.',
      );
    }

    const { data: prs } = await gh.pulls.list({
      owner,
      repo: name,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    });

    const stored = await loadGitHubToken();
    const connectedLogin = stored?.login.toLowerCase();

    // Note: input carries `agentId` so we can attribute the claim to a specific
    // instance. SelectTaskInput was extended at the orchestrator boundary.
    const agentId = input.agentId ?? null;

    // Forced retry (manual Retry button / infra auto-retry): re-review the
    // exact PR the failed run targeted, bypassing the sweep's dedup + caps.
    // We still fetch the PR fresh (its head SHA may have moved) and keep the
    // allowlist / cross-install / atomic-claim safety gates.
    const forcedPr = input.forceTask ? parsePrTaskRef(input.taskId ?? null) : null;
    if (forcedPr) {
      const pr = await gh.pulls
        .get({ owner, repo: name, pull_number: forcedPr.prNumber })
        .then((r) => r.data)
        .catch(() => null);
      if (!pr || pr.state !== 'open') {
        throw new ObeliskError(
          'PRS_ALL_FILTERED',
          `PR #${forcedPr.prNumber} is closed or no longer exists — nothing to re-review.`,
          'Pick a different run to retry, or run PR Reviewer to sweep open PRs.',
        );
      }
      const result = await prepareReviewTask({
        gh,
        owner,
        name,
        pr,
        repo: input.repo,
        connectedLogin,
        agentId,
        force: true,
      });
      if ('skip' in result) {
        throw new ObeliskError(
          'PRS_ALL_FILTERED',
          `PR #${pr.number} can't be reviewed: ${skipPhrase(result.skip)}.`,
          hintForSkip(result.skip),
        );
      }
      return result;
    }

    // Tally why each open PR was passed over, so a manual Run now can report
    // the specific reason instead of the opaque "nothing to do" sentinel.
    const skipped = {
      alreadyReviewed: 0,
      failedCap: 0,
      not_allowlisted: 0,
      claimed_elsewhere: 0,
      claim_lost: 0,
      no_author: 0,
    };

    for (const pr of prs) {
      const headSha = pr.head.sha;
      const taskRef = `pr#${pr.number}@${headSha.slice(0, 12)}`;

      // Skip if any instance already reviewed this exact SHA.
      if (
        wasReviewedAtSha(input.repo.id, pr.number, headSha) ||
        alreadyReviewed(input.repo.id, taskRef)
      ) {
        skipped.alreadyReviewed++;
        continue;
      }

      // Stop re-claiming a SHA that keeps failing — otherwise a doomed review
      // re-runs on every tick (its 'failed' claim doesn't block re-claim).
      if (failedAttemptCount(input.repo.id, pr.number, headSha) >= FAILED_REVIEW_ATTEMPT_CAP) {
        skipped.failedCap++;
        continue;
      }

      const result = await prepareReviewTask({
        gh,
        owner,
        name,
        pr,
        repo: input.repo,
        connectedLogin,
        agentId,
      });
      if ('skip' in result) {
        skipped[result.skip]++;
        continue;
      }
      return result;
    }

    // Nothing claimable. Scheduled / webhook sweeps stay quiet (the
    // orchestrator turns null into the "nothing to do" sentinel) so the cron
    // tick doesn't spam scheduler_error rows. A manual Run now gets the why.
    if (!isManual) return null;

    if (prs.length === 0) {
      throw new ObeliskError(
        'NO_OPEN_PRS',
        `No open pull requests in ${owner}/${name} to review.`,
        'PR Reviewer reviews open PRs. Open one (or push a commit to an existing PR), then run again.',
      );
    }

    const n = prs.length;
    const reasons: string[] = [];
    if (skipped.alreadyReviewed > 0)
      reasons.push(`${skipped.alreadyReviewed} already reviewed at the latest commit`);
    if (skipped.failedCap > 0)
      reasons.push(`${skipped.failedCap} past the failed-review attempt cap`);
    if (skipped.not_allowlisted > 0)
      reasons.push(`${skipped.not_allowlisted} authored by users not on the allowlist`);
    if (skipped.claimed_elsewhere > 0)
      reasons.push(`${skipped.claimed_elsewhere} claimed by another Obelisk install`);
    if (skipped.claim_lost > 0)
      reasons.push(`${skipped.claim_lost} just claimed by another reviewer instance`);
    if (skipped.no_author > 0) reasons.push(`${skipped.no_author} missing an author`);

    const message =
      reasons.length > 0
        ? `All ${n} open PR${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} skipped: ${reasons.join(', ')}.`
        : `None of the ${n} open PR${n === 1 ? '' : 's'} could be claimed for review.`;
    const hint =
      skipped.not_allowlisted > 0
        ? 'Add the PR authors via the Allowlist settings.'
        : skipped.failedCap > 0
          ? 'Use Retry on the failed run to force another attempt.'
          : 'Push a new commit to a PR to trigger a fresh review.';
    throw new ObeliskError('PRS_ALL_FILTERED', message, hint);
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const review = parseReviewOutput(input.runResult.reasoning);
    const issueNumber = input.task.githubNumber;
    if (!review || !issueNumber) return [];

    // Fetch PR body (for Evidence cross-check) and author (to detect
    // self-authored PRs, which GitHub refuses to APPROVE / REQUEST_CHANGES).
    const prInfo = await fetchPrInfoForReview(input.repo.githubFullName, issueNumber);

    const hasFixUpDiff = (input.runResult.patch.diff ?? '').trim().length > 0;

    // Verdict math: when the agent committed fixes, override based on
    // remaining P0/P1 findings. No remaining → APPROVE (PR is merge-ready).
    // Any remaining → COMMENT (we made progress; humans need to handle the
    // rest). The Evidence override below still wins over both.
    let workingReview = review;
    if (hasFixUpDiff) {
      const remainingHighSeverity = review.findings.some(
        (f) => f.severity === 'P0' || f.severity === 'P1',
      );
      const newVerdict: ReviewOutput['verdict'] = remainingHighSeverity ? 'COMMENT' : 'APPROVE';
      const note = remainingHighSeverity
        ? '\n\n_PR Reviewer pushed fix-up commits for some findings; the items above still need human attention._'
        : '\n\n_PR Reviewer pushed fix-up commits addressing the findings above._';
      workingReview = {
        ...review,
        verdict: newVerdict,
        summary: review.summary + note,
      };
    }

    const enforced = enforceEvidenceVerdict(workingReview, prInfo.evidence);

    // GitHub rejects pulls.createReview with APPROVE / REQUEST_CHANGES when
    // the reviewer authored the PR. Route the body through an issue comment
    // (allowed on your own PR) instead, with a verdict header so the user
    // can still see the bottom line.
    const authedLogin = (await getAuthedLogin().catch(() => null)) ?? null;
    const isSelfAuthored =
      authedLogin !== null &&
      prInfo.author !== null &&
      authedLogin.toLowerCase() === prInfo.author.toLowerCase();

    const verdictPlan: PublishPlan = isSelfAuthored
      ? {
          kind: 'comment',
          issueNumber,
          body: `**Verdict:** ${enforced.event}\n\n${enforced.body}`,
        }
      : {
          kind: 'review',
          prNumber: issueNumber,
          event: enforced.event,
          body: enforced.body,
        };

    // PR plan goes FIRST so the publisher's git push lands before the
    // review references the new SHA on GitHub. The orchestrator overrides
    // `head` from the worktree branch and skips the body render because
    // existingPrNumber is set (publisher won't call pulls.create).
    if (hasFixUpDiff) {
      const prPlan: PublishPlan = {
        kind: 'pr',
        title: `fix: address review findings on #${issueNumber}`,
        body: '',
        head: '',
        base: input.repo.defaultBranch,
      };
      return [prPlan, verdictPlan];
    }
    return [verdictPlan];
  },
};

/* ---------- task preparation ---------- */

interface ReviewablePr {
  number: number;
  title: string;
  body?: string | null;
  head: { sha: string; ref: string };
  base?: { ref?: string | null } | null;
  user?: { login?: string | null } | null;
  labels?: ReadonlyArray<string | { name?: string | null } | null> | null;
  assignees?: ReadonlyArray<{ login?: string | null } | null> | null;
}

/** Why a PR was passed over by `prepareReviewTask` (for user-facing reasons). */
type PrSkip = 'no_author' | 'not_allowlisted' | 'claimed_elsewhere' | 'claim_lost';

/** Short phrase describing a skip reason, for a single-PR (forced retry) message. */
function skipPhrase(skip: PrSkip): string {
  switch (skip) {
    case 'no_author':
      return 'it has no author';
    case 'not_allowlisted':
      return 'its author is not on the allowlist';
    case 'claimed_elsewhere':
      return 'another Obelisk install already claimed it';
    case 'claim_lost':
      return 'another reviewer instance just claimed it';
  }
}

/** Actionable next step for a skip reason. */
function hintForSkip(skip: PrSkip): string {
  switch (skip) {
    case 'not_allowlisted':
      return 'Add the PR author via the Allowlist settings.';
    case 'claimed_elsewhere':
    case 'claim_lost':
      return 'Another instance owns this PR — wait for it to finish.';
    case 'no_author':
      return 'This usually means a deleted GitHub account; pick a different PR.';
  }
}

/**
 * Apply the per-PR gates (actor allowlist, cross-install guard, atomic claim,
 * fix-mode gating) and build the SelectedTask. Returns `{ skip }` when the PR
 * should be passed over (not allowlisted, claimed elsewhere, lost the claim
 * race) so the caller can report the specific reason.
 *
 * Shared by the normal sweep and the forced-retry fast path. `force` bypasses
 * the fix-mode livelock cap (a manual retry is the user's explicit call); the
 * sweep's SHA-level dedup checks live in selectTask and are simply not run on
 * the forced path.
 */
async function prepareReviewTask(opts: {
  gh: NonNullable<Awaited<ReturnType<typeof getGithub>>>;
  owner: string;
  name: string;
  pr: ReviewablePr;
  repo: SelectTaskInput['repo'];
  connectedLogin: string | undefined;
  agentId: string | null;
  force?: boolean;
}): Promise<SelectedTask | { skip: PrSkip }> {
  const { gh, owner, name, pr, repo, connectedLogin, agentId, force } = opts;
  const headSha = pr.head.sha;
  const taskRef = `pr#${pr.number}@${headSha.slice(0, 12)}`;

  const author = pr.user?.login?.toLowerCase();
  if (!author) return { skip: 'no_author' };

  // Auto-allow the connected user so we review our own / Obelisk-opened PRs
  // (PRD §8.1: same Evidence-Pack enforcement loop). The allowlist gate stays
  // even on a forced retry — it's a non-negotiable safety control.
  if (author !== connectedLogin) {
    const allow = checkActorAllowlist({ repoId: repo.id, login: author, source: taskRef });
    if (!allow.ok) return { skip: 'not_allowlisted' };
  }

  // Cross-installation guard: skip PRs another Obelisk install already claimed
  // (label + self-assignee signature). Run before the DB claim so we don't
  // churn the claim table on PRs we don't own.
  if (
    isClaimedByAnotherInstall({
      labels: normalizeGithubLabels(pr.labels),
      assignees: normalizeGithubAssignees(pr.assignees),
      connectedLogin: connectedLogin ?? null,
      source: taskRef,
    })
  ) {
    return { skip: 'claimed_elsewhere' };
  }

  // Atomic claim — guarantees only one reviewer instance picks this PR/SHA.
  if (!agentId) {
    // No agent id available (legacy callers). Skip the claim and rely on
    // alreadyReviewed dedup; behavior matches pre-multi-instance. Legacy
    // callers also miss out on fix mode — that's intentional, fix mode
    // requires the claim row to attribute the eventual push.
    return {
      task: {
        ref: taskRef,
        kind: 'review',
        summary: `Reviewing PR #${pr.number}: ${pr.title}`,
        context: prContextFor(pr, {
          fixMode: false,
          hasConflicts: false,
          baseBranch: repo.defaultBranch,
        }),
        githubNumber: pr.number,
      },
    };
  }
  const claim = claimPrReview({ repoId: repo.id, prNumber: pr.number, headSha, agentId });
  if (!claim) return { skip: 'claim_lost' };

  // Fix-mode gating. All three conditions must hold:
  //  - PR was opened by Obelisk (head ref `obelisk/<run-id>`).
  //  - Repo safety mode permits commit + push.
  //  - We haven't cycled through too many fix attempts on this PR (livelock
  //    guard) — bypassed on a forced retry.
  const isObeliskPr = pr.head.ref.startsWith(OBELISK_BRANCH_PREFIX);
  const safetyAllowsFix = repo.mode === 'prs' || repo.mode === 'automerge';
  const livelockOk =
    force === true || priorReviewerRunCount(repo.id, pr.number) < REVIEW_LIVELOCK_CAP;
  const fixMode = isObeliskPr && safetyAllowsFix && livelockOk;

  // mergeable_state is computed lazily by GitHub. We only need it for fix-mode
  // PRs (the agent can't push conflict resolutions on a human PR anyway).
  const hasConflicts = fixMode
    ? await prHasConflicts(gh, owner, name, pr.number).catch(() => false)
    : false;
  const baseBranch =
    pr.base?.ref && typeof pr.base.ref === 'string' && pr.base.ref.length > 0
      ? pr.base.ref
      : repo.defaultBranch;

  await postClaimSignal({ repo, issueNumber: pr.number, source: taskRef });

  return {
    task: {
      ref: taskRef,
      kind: 'review',
      summary: `${fixMode ? 'Fixing' : 'Reviewing'} PR #${pr.number}: ${pr.title}`,
      context: prContextFor(pr, { fixMode, hasConflicts, baseBranch }),
      githubNumber: pr.number,
    },
    prReviewClaimId: claim.id,
    ...(fixMode ? { attachToBranch: { branch: pr.head.ref, existingPrNumber: pr.number } } : {}),
  };
}

/* ---------- output parsing ---------- */

interface ReviewOutput {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  summary: string;
  findings: ReviewFinding[];
  verdict_block: string;
  confidence: number;
}

interface ReviewFinding {
  axis: 'correctness' | 'design' | 'tests' | 'security' | 'perf';
  severity: 'P0' | 'P1' | 'P2';
  where: string;
  note: string;
}

const PR_REVIEW_END_MARKER = 'END_PR_REVIEW';

export function parseReviewOutput(stdout: string): ReviewOutput | null {
  const wrapped = stdout.replace(
    new RegExp(`${PR_REVIEW_MARKER}\\s*([\\s\\S]*?)\\s*${PR_REVIEW_END_MARKER}`),
    (_match, body: string) => `${PR_REVIEW_MARKER} [${body.trim()}] ${PR_REVIEW_END_MARKER}`,
  );
  const items = parseFencedJson<ReviewOutput>(
    wrapped,
    PR_REVIEW_MARKER,
    PR_REVIEW_END_MARKER,
    isReviewOutput,
  );
  return items[0] ?? null;
}

function isReviewOutput(v: unknown): v is ReviewOutput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o['verdict'] === 'APPROVE' ||
      o['verdict'] === 'REQUEST_CHANGES' ||
      o['verdict'] === 'COMMENT') &&
    typeof o['summary'] === 'string' &&
    Array.isArray(o['findings']) &&
    typeof o['verdict_block'] === 'string' &&
    typeof o['confidence'] === 'number'
  );
}

/* ---------- evidence cross-check + verdict enforcement ---------- */

export async function fetchEvidenceCrossCheck(
  repoFullName: string,
  prNumber: number,
): Promise<ReturnType<typeof crossCheckEvidence>> {
  return (await fetchPrInfoForReview(repoFullName, prNumber)).evidence;
}

interface PrInfoForReview {
  evidence: ReturnType<typeof crossCheckEvidence>;
  author: string | null;
}

async function fetchPrInfoForReview(
  repoFullName: string,
  prNumber: number,
): Promise<PrInfoForReview> {
  const gh = await getGithub();
  if (!gh) return { evidence: crossCheckEvidence(''), author: null };
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) return { evidence: crossCheckEvidence(''), author: null };
  const { data } = await gh.pulls.get({ owner, repo: name, pull_number: prNumber });
  return {
    evidence: crossCheckEvidence(data.body ?? ''),
    author: data.user?.login ?? null,
  };
}

export function enforceEvidenceVerdict(
  review: ReviewOutput,
  evidence: ReturnType<typeof crossCheckEvidence>,
): { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string } {
  const body = renderReviewBody(review);
  if (isEvidenceComplete(evidence)) {
    return { event: review.verdict, body };
  }
  const preamble = renderEvidencePreamble(evidence);
  return { event: 'REQUEST_CHANGES', body: `${preamble}\n\n---\n\n${body}` };
}

function renderReviewBody(review: ReviewOutput): string {
  const findingLines = review.findings.map(
    (f) => `- **[${f.severity} · ${f.axis}]** \`${f.where}\` — ${f.note}`,
  );
  return [
    review.summary.trim(),
    '',
    findingLines.length > 0 ? '## Findings' : '',
    ...findingLines,
    '',
    review.verdict_block.trim(),
    '',
    '_Filed by Obelisk PR Reviewer._',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function renderEvidencePreamble(check: ReturnType<typeof crossCheckEvidence>): string {
  if (!check.hasEvidenceSection) {
    return [
      '## Evidence Pack incomplete',
      '',
      'This PR has no `## Evidence` section. Per Obelisk policy (PRD §7.2), every PR must include an Evidence Pack with `Tests`, `Screenshots`, and `Logs` subheadings.',
      '',
      'Re-running the producing agent (Bug Fixer or Feature Builder) will regenerate the section.',
    ].join('\n');
  }
  const empty =
    check.emptySubheadings.length > 0
      ? `Empty subheadings: ${check.emptySubheadings.map((s) => `\`### ${s}\``).join(', ')}.`
      : '';
  const missing =
    check.missingSubheadings.length > 0
      ? `Missing subheadings: ${check.missingSubheadings.map((s) => `\`### ${s}\``).join(', ')}.`
      : '';
  return [
    '## Evidence Pack incomplete',
    '',
    'This PR is missing required Evidence items:',
    '',
    empty,
    missing,
    '',
    'Per Obelisk policy (PRD §7.2), every PR opened by an agent must populate `### Tests`, `### Screenshots`, and `### Logs` (when applicable to the change kind).',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* ---------- dedup + helpers ---------- */

/**
 * Have we already produced a PR Reviewer run for this PR at this SHA?
 * The head SHA is encoded in task_ref (`pr#<n>@<short-sha>`), so a
 * force-push produces a new task and gets a fresh review.
 */
function alreadyReviewed(repoId: string, taskRef: string): boolean {
  const row = getDb()
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count FROM runs
       WHERE repo_id = ? AND agent_name = 'pr-reviewer'
         AND task_ref = ? AND state = 'done'`,
    )
    .get(repoId, taskRef);
  return (row?.count ?? 0) > 0;
}

/**
 * Count completed `pr-reviewer` runs against this PR across ALL SHAs.
 * Used to cap the fix-mode livelock: each fix-up commit produces a new
 * SHA which would otherwise let the next sweep re-claim the PR forever.
 * The cap (REVIEW_LIVELOCK_CAP) is a heuristic — beyond it, fall back
 * to review-only.
 */
function priorReviewerRunCount(repoId: string, prNumber: number): number {
  const row = getDb()
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM runs
       WHERE repo_id = ? AND agent_name = 'pr-reviewer'
         AND task_ref LIKE ? AND state = 'done'`,
    )
    .get(repoId, `pr#${prNumber}@%`);
  return row?.c ?? 0;
}

interface PrContextOpts {
  fixMode: boolean;
  hasConflicts: boolean;
  baseBranch: string;
}

function prContextFor(
  pr: { title: string; body?: string | null; number: number; head: { ref: string } },
  opts: PrContextOpts,
): string {
  const modeHint = opts.fixMode
    ? `FIX MODE: this PR was opened by Obelisk on branch \`${pr.head.ref}\` (base: \`${opts.baseBranch}\`). The worktree is checked out on that branch — you may commit fixes for findings you're confident about. See agents/pr-reviewer.md for the rules.`
    : `REVIEW ONLY: do not modify any files. Post the review and stop.`;
  const conflictHint =
    opts.fixMode && opts.hasConflicts
      ? `\n\nMERGE CONFLICTS: GitHub reports this PR is not mergeable against \`${opts.baseBranch}\`. Resolve before reviewing:\n\n` +
        '```\n' +
        `git fetch origin ${opts.baseBranch}\n` +
        `git merge origin/${opts.baseBranch}\n` +
        '# resolve conflicts, then:\n' +
        'git add -A && git commit --no-edit\n' +
        '```\n\n' +
        "If a conflict can't be resolved safely, emit it as a P0 finding and stop — do not guess."
      : '';
  return `Reviewing PR #${pr.number}: ${pr.title}\n\n${modeHint}${conflictHint}\n\n${pr.body ?? '(no PR body)'}`;
}

/**
 * Returns true when GitHub reports the PR is not mergeable into its base.
 * `mergeable` is computed asynchronously — null means "still computing";
 * we treat unknown as "no conflicts" (the agent will discover them via
 * `git merge` if they exist).
 */
async function prHasConflicts(
  gh: Awaited<ReturnType<typeof getGithub>>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  if (!gh) return false;
  const { data } = await gh.pulls.get({ owner, repo, pull_number: prNumber });
  if (data.mergeable === false) return true;
  if (typeof data.mergeable_state === 'string' && data.mergeable_state === 'dirty') return true;
  return false;
}
