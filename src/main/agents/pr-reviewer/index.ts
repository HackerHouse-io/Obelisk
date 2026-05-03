import { getDb } from '../../db';
import { getGithub } from '../../github/client';
import { loadGitHubToken } from '../../auth/token-store';
import { ObeliskError } from '../../../shared/errors';
import { checkActorAllowlist } from '../lib/actor-allowlist';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { crossCheckEvidence, isEvidenceComplete } from './evidence-cross-check';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const prReviewerHandler: AgentHandler = {
  name: 'pr-reviewer',
  // Reviews never write code, never open PRs.
  skipsEvidenceGate: true,
  producesPatch: false,

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

    for (const pr of prs) {
      // Encoding the head SHA in task_ref means a force-push (new SHA)
      // produces a new task and gets a fresh review — no LIKE search needed.
      const taskRef = `pr#${pr.number}@${pr.head.sha.slice(0, 12)}`;
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

      return {
        task: {
          ref: taskRef,
          kind: 'review',
          context: prContextFor(pr),
          githubNumber: pr.number,
        },
      };
    }

    return null;
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const review = parseReviewOutput(input.runResult.reasoning);
    const issueNumber = input.task.githubNumber;
    if (!review || !issueNumber) return [];

    // Fetch the PR body to cross-check the Evidence section.
    const evidence = await fetchEvidenceCrossCheck(input.repo.githubFullName, issueNumber);
    const enforced = enforceEvidenceVerdict(review, evidence);

    return [
      {
        kind: 'review',
        prNumber: issueNumber,
        event: enforced.event,
        body: enforced.body,
      },
    ];
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

export function parseReviewOutput(stdout: string): ReviewOutput | null {
  const wrapped = stdout.replace(
    /BEGIN_PR_REVIEW\s*([\s\S]*?)\s*END_PR_REVIEW/,
    (_match, body: string) => `BEGIN_PR_REVIEW [${body.trim()}] END_PR_REVIEW`,
  );
  const items = parseFencedJson<ReviewOutput>(
    wrapped,
    'BEGIN_PR_REVIEW',
    'END_PR_REVIEW',
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
  const gh = await getGithub();
  if (!gh) return crossCheckEvidence('');
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) return crossCheckEvidence('');
  const { data } = await gh.pulls.get({ owner, repo: name, pull_number: prNumber });
  return crossCheckEvidence(data.body ?? '');
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

function prContextFor(pr: { title: string; body: string | null; number: number }): string {
  return `Reviewing PR #${pr.number}: ${pr.title}\n\n${pr.body ?? '(no PR body)'}`;
}
