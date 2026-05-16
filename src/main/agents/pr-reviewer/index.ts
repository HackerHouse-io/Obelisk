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
import { crossCheckEvidence, isEvidenceComplete } from './evidence-cross-check';
import { claimPrReview, wasReviewed as wasReviewedAtSha } from '../../db/pr-review-claims';
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
    const [owner, name] = input.repo.githubFullName.split('/');
    if (!owner || !name) return null;

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

    for (const pr of prs) {
      const headSha = pr.head.sha;
      const taskRef = `pr#${pr.number}@${headSha.slice(0, 12)}`;

      // Skip if any instance already reviewed this exact SHA.
      if (wasReviewedAtSha(input.repo.id, pr.number, headSha)) continue;
      if (alreadyReviewed(input.repo.id, taskRef)) continue;

      const author = pr.user?.login?.toLowerCase();
      if (!author) continue;

      // Auto-allow the connected user so we review our own / Obelisk-opened
      // PRs (PRD §8.1: same Evidence-Pack enforcement loop).
      if (author !== connectedLogin) {
        const allow = checkActorAllowlist({
          repoId: input.repo.id,
          login: author,
          source: taskRef,
        });
        if (!allow.ok) continue;
      }

      // Cross-installation guard: skip PRs another Obelisk install already
      // claimed (label + self-assignee signature). Run before the DB claim
      // so we don't churn the claim table on PRs we don't own.
      if (
        isClaimedByAnotherInstall({
          labels: normalizeGithubLabels(pr.labels),
          assignees: normalizeGithubAssignees(pr.assignees),
          connectedLogin: connectedLogin ?? null,
          source: taskRef,
        })
      ) {
        continue;
      }

      // Atomic claim — guarantees only one reviewer instance picks this PR/SHA.
      // If another instance got here first the partial-unique index returns 0
      // changes and we fall through to the next candidate.
      if (!agentId) {
        // No agent id available (legacy callers). Skip the claim and rely on
        // alreadyReviewed dedup; behavior matches pre-multi-instance.
        // Legacy callers also miss out on fix mode — that's intentional, fix
        // mode requires the claim row to attribute the eventual push.
        return {
          task: {
            ref: taskRef,
            kind: 'review',
            summary: `Reviewing PR #${pr.number}: ${pr.title}`,
            context: prContextFor(pr, {
              fixMode: false,
              hasConflicts: false,
              baseBranch: input.repo.defaultBranch,
            }),
            githubNumber: pr.number,
          },
        };
      }
      const claim = claimPrReview({
        repoId: input.repo.id,
        prNumber: pr.number,
        headSha,
        agentId,
      });
      if (!claim) continue;

      // Fix-mode gating. All three conditions must hold:
      //  - PR was opened by Obelisk (head ref `obelisk/<run-id>`).
      //  - Repo safety mode permits commit + push (publisher would reject
      //    otherwise; refuse the dispatch up front rather than spawning
      //    a doomed run).
      //  - We haven't already cycled through too many fix attempts on
      //    this PR (livelock guard — the reviewer's own push creates a
      //    new SHA which would otherwise let the next sweep re-claim).
      const isObeliskPr = pr.head.ref.startsWith(OBELISK_BRANCH_PREFIX);
      const safetyAllowsFix = input.repo.mode === 'prs' || input.repo.mode === 'automerge';
      const priorRuns = priorReviewerRunCount(input.repo.id, pr.number);
      const livelockOk = priorRuns < REVIEW_LIVELOCK_CAP;
      const fixMode = isObeliskPr && safetyAllowsFix && livelockOk;

      // mergeable_state is computed lazily by GitHub. pulls.list returns it
      // stale or absent; pulls.get triggers / returns the current value.
      // We only need it for fix-mode PRs (the agent can't push conflict
      // resolutions on a human PR anyway).
      const hasConflicts = fixMode
        ? await prHasConflicts(gh, owner, name, pr.number).catch(() => false)
        : false;
      const baseBranch =
        pr.base?.ref && typeof pr.base.ref === 'string' && pr.base.ref.length > 0
          ? pr.base.ref
          : input.repo.defaultBranch;

      await postClaimSignal({
        repo: input.repo,
        issueNumber: pr.number,
        source: taskRef,
      });

      return {
        task: {
          ref: taskRef,
          kind: 'review',
          summary: `${fixMode ? 'Fixing' : 'Reviewing'} PR #${pr.number}: ${pr.title}`,
          context: prContextFor(pr, { fixMode, hasConflicts, baseBranch }),
          githubNumber: pr.number,
        },
        prReviewClaimId: claim.id,
        ...(fixMode
          ? { attachToBranch: { branch: pr.head.ref, existingPrNumber: pr.number } }
          : {}),
      };
    }

    return null;
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
  pr: { title: string; body: string | null; number: number; head: { ref: string } },
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
