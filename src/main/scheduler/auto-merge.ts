import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { listRepos } from '../db/repos';
import { getDb } from '../db';
import { getSetting } from '../db/settings';
import { getRun, getWorktreePath } from '../db/runs';
import { getGithub } from '../github/client';
import { OBELISK_LABELS } from '../publisher/labels';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { appendAudit } from '../logger/audit';
import { runAgent } from '../orchestrator/run';
import type { ResumeContext } from '../agents/types';
import type { AgentName, Repo } from '../../shared/types';

const REBASE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const ESCALATION_MAX_ATTEMPTS = 2;
const CI_RETRY_LOG_BUDGET = 10 * 1024; // 10KB total across all failed jobs
const CI_RETRY_LOG_LINES_PER_JOB = 200;

/**
 * Auto-merge sweep (PRD §3.2 / §6.1).
 *
 * Three conditions ALL must hold for a merge:
 *   1. repo.mode === 'automerge'
 *   2. PR carries the `obelisk:automerge` label
 *   3. Combined commit status (legacy + check-runs) is `success`
 *
 * If any condition fails, we audit-log the decision and move on. We never
 * remove the label automatically — leaving the choice with the human.
 *
 * Per-PR outcomes are written to `audit_log` (`auto_merge_skipped` or
 * `auto_merge_merged`); that's the durable signal. The function returns
 * void.
 *
 * Phase 1.5 also adds `rebaseDirtyPrs(repo)` which runs ahead of the merge
 * loop on `prs`/`automerge` repos so PRs that became `mergeable_state='dirty'`
 * after another PR merged get auto-rebased before they have a chance to be
 * skipped.
 */
export async function autoMergeSweep(): Promise<void> {
  for (const repo of listRepos()) {
    if (repo.mode !== 'prs' && repo.mode !== 'automerge') continue;
    const mergeQueue = isMergeQueueEnabled(repo.id);
    // GitHub's native merge queue serializes merges + rebases server-side,
    // so the local rebase-on-dirty sweep is redundant (and would race
    // with the queue). Skip it when the user has opted in.
    if (!mergeQueue) {
      await rebaseDirtyPrs(repo).catch((e: unknown) => {
        console.warn(`[obelisk] rebase sweep failed for ${repo.githubFullName}:`, e);
      });
    }
    await retryFailedCiPrs(repo).catch((e: unknown) => {
      console.warn(`[obelisk] CI-retry sweep failed for ${repo.githubFullName}:`, e);
    });
    if (repo.mode !== 'automerge') continue;
    await sweepRepo(repo, mergeQueue).catch((e: unknown) => {
      // Network or auth errors are non-fatal — try again next tick.
      console.warn(`[obelisk] auto-merge sweep failed for ${repo.githubFullName}:`, e);
    });
  }
}

function isMergeQueueEnabled(repoId: string): boolean {
  return getSetting<boolean>(`repo:${repoId}`, 'merge_queue_enabled') === true;
}

async function sweepRepo(repo: Repo, mergeQueue: boolean): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  const { data: prs } = await gh.pulls.list({
    owner,
    repo: name,
    state: 'open',
    per_page: 50,
  });

  for (const pr of prs) {
    if (!pr.labels.some((l) => l.name === OBELISK_LABELS.automerge)) continue;
    if (pr.draft) {
      logSkip(pr.number, 'pr_is_draft');
      continue;
    }

    if (mergeQueue) {
      // Hand off to GitHub's native merge queue. Required-checks
      // verification happens server-side; we only check that the PR has
      // the queue label and isn't a draft. PR's GraphQL node id comes
      // straight from the REST response.
      try {
        await enqueuePullRequestForMergeQueue(gh, pr.node_id);
        logMergeQueueEnqueued(pr.number);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logSkip(pr.number, `merge_queue_enqueue_failed:${message.slice(0, 80)}`);
      }
      continue;
    }

    const checks = await isRefGreen(gh, owner, name, pr.head.sha);
    if (!checks.green) {
      logSkip(pr.number, checks.reason);
      continue;
    }

    try {
      await gh.pulls.merge({
        owner,
        repo: name,
        pull_number: pr.number,
        // Squash is the v0.1 default. v0.2 makes this per-repo configurable.
        merge_method: 'squash',
      });
      logMerge(pr.number);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      logSkip(pr.number, `merge_failed_${status ?? 'unknown'}`);
    }
  }
}

const ENQUEUE_PR_MUTATION = `
  mutation EnqueuePR($prId: ID!) {
    enqueuePullRequest(input: { pullRequestId: $prId }) {
      mergeQueueEntry { id position }
    }
  }
`;

async function enqueuePullRequestForMergeQueue(
  gh: NonNullable<Awaited<ReturnType<typeof getGithub>>>,
  prNodeId: string,
): Promise<void> {
  await gh.graphql(ENQUEUE_PR_MUTATION, { prId: prNodeId });
}

interface GreenCheck {
  green: boolean;
  reason: string;
}

/**
 * Combine legacy commit-statuses (Travis-era) with check-runs (Actions /
 * modern CI). All must be `success` for the ref to count as green.
 */
async function isRefGreen(
  gh: NonNullable<Awaited<ReturnType<typeof getGithub>>>,
  owner: string,
  repo: string,
  ref: string,
): Promise<GreenCheck> {
  const [combined, checks] = await Promise.all([
    gh.repos.getCombinedStatusForRef({ owner, repo, ref }),
    gh.checks.listForRef({ owner, repo, ref, per_page: 100 }),
  ]);

  // Only fail on the legacy combined-status when the repo actually publishes
  // statuses through that API. Pure check-runs repos report `state='pending'`
  // with `statuses=[]` even when their checks are green — fall through to the
  // check-runs loop in that case.
  if (combined.data.statuses.length > 0 && combined.data.state !== 'success') {
    return { green: false, reason: `combined_status_${combined.data.state}` };
  }
  for (const run of checks.data.check_runs) {
    if (run.status !== 'completed') {
      return { green: false, reason: `check_pending_${run.name}` };
    }
    if (
      run.conclusion !== 'success' &&
      run.conclusion !== 'neutral' &&
      run.conclusion !== 'skipped'
    ) {
      return { green: false, reason: `check_failed_${run.name}_${run.conclusion ?? 'null'}` };
    }
  }
  return { green: true, reason: 'all_green' };
}

/* ---------- Rebase-on-dirty (Phase 2.2) ---------- */

/**
 * Find Obelisk-authored PRs that became `mergeable_state='dirty'` after
 * another PR merged on top of their base, attempt a local rebase against
 * the default branch, and force-push with `--force-with-lease`. On
 * conflict, escalate by adding `obelisk:needs-human` and a comment.
 *
 * Cooldown: at most one attempt per PR per `REBASE_COOLDOWN_MS`. After
 * `ESCALATION_MAX_ATTEMPTS` total attempts (counted via `audit_log` rows),
 * escalation fires whether or not a rebase conflict happened so we don't
 * loop on a structural problem.
 */
export async function rebaseDirtyPrs(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;
  if (!existsSync(repo.localPath)) return;

  const { data: prs } = await gh.pulls.list({
    owner,
    repo: name,
    state: 'open',
    per_page: 50,
  });

  for (const pr of prs) {
    if (!pr.head.ref.startsWith('obelisk/')) continue;

    let detail;
    try {
      detail = await gh.pulls.get({ owner, repo: name, pull_number: pr.number });
    } catch {
      continue;
    }
    // GitHub computes `mergeable` async — null means "ask again next sweep".
    if (detail.data.mergeable === null) continue;
    if (detail.data.mergeable_state !== 'dirty') continue;

    const attempts = countRebaseAttempts(pr.number);
    const recentAttempt = mostRecentRebaseAttemptAt(pr.number);
    if (recentAttempt && Date.now() - recentAttempt < REBASE_COOLDOWN_MS) continue;

    const runId = parseRunIdFromBranch(pr.head.ref);
    if (!runId) continue;
    const run = getRun(runId);
    if (!run) {
      // Original run was deleted — escalate without trying.
      await escalate(repo, pr.number, 'no_originating_run');
      continue;
    }
    if (run.taskRef && hasActiveRunForTaskRef(repo.id, run.taskRef, run.id)) {
      // A retry is already in flight for the same task — let it finish.
      continue;
    }

    if (attempts >= ESCALATION_MAX_ATTEMPTS) {
      await escalate(repo, pr.number, 'max_attempts_reached');
      logRebaseAttempt(pr.number, 'escalated', { reason: 'max_attempts_reached' });
      continue;
    }

    const outcome = await attemptRebase({
      repo,
      runId,
      branch: pr.head.ref,
    });
    logRebaseAttempt(pr.number, outcome.outcome, outcome.detail);

    if (outcome.outcome === 'conflict') {
      await escalate(repo, pr.number, 'rebase_conflict');
    }
  }
}

interface AttemptInput {
  repo: Repo;
  runId: string;
  branch: string;
}

interface AttemptOutput {
  outcome: 'success' | 'conflict' | 'error';
  detail: Record<string, unknown>;
}

async function attemptRebase(input: AttemptInput): Promise<AttemptOutput> {
  const { repo, runId, branch } = input;
  // Recreate the worktree if the prior one was reaped/destroyed.
  let worktreePath = getWorktreePath(runId);
  let createdHere = false;
  if (!worktreePath || !existsSync(worktreePath)) {
    try {
      const handle = await createWorktree({
        repoPath: repo.localPath,
        repoId: repo.id,
        runId: `${runId}-rebase-${Date.now()}`,
        baseBranch: branch,
      });
      worktreePath = handle.worktreePath;
      createdHere = true;
    } catch (e) {
      return {
        outcome: 'error',
        detail: { step: 'create_worktree', error: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  const git = simpleGit(worktreePath);
  const cleanup = async (): Promise<void> => {
    if (createdHere && worktreePath) {
      await destroyWorktree(repo.localPath, worktreePath).catch(() => undefined);
    }
  };

  // Inner pipeline: fetch → rebase → push. We run it once; on a stale-info
  // push rejection we re-run the WHOLE pipeline (fetch a freshly advanced
  // origin, rebase atop it, retry push). Anything else fails fast.
  let lastPushError: unknown = null;
  let retried = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await git.fetch('origin', repo.defaultBranch);
    } catch (e) {
      await cleanup();
      return {
        outcome: 'error',
        detail: { step: 'fetch', error: e instanceof Error ? e.message : String(e) },
      };
    }

    try {
      await git.rebase([`origin/${repo.defaultBranch}`]);
    } catch (e) {
      await git.raw(['rebase', '--abort']).catch(() => undefined);
      await cleanup();
      return {
        outcome: 'conflict',
        detail: { step: 'rebase', error: e instanceof Error ? e.message : String(e) },
      };
    }

    try {
      await git.push(['--force-with-lease', 'origin', branch]);
      await cleanup();
      return { outcome: 'success', detail: { branch, ...(retried ? { retried: true } : {}) } };
    } catch (e) {
      lastPushError = e;
      // Only retry when origin advanced between our fetch and our push.
      // `--force-with-lease` rejects with "stale info"; a vanilla push
      // rejection looks like "non-fast-forward" or "[rejected]". Any
      // other error (auth, network, config) fails fast.
      if (!isPushRetryable(e) || attempt > 0) break;
      retried = true;
    }
  }

  await cleanup();
  return {
    outcome: 'error',
    detail: {
      step: 'push',
      retried,
      error: lastPushError instanceof Error ? lastPushError.message : String(lastPushError),
    },
  };
}

/**
 * True when a `git push --force-with-lease` failure is the kind we should
 * retry once: origin advanced between our fetch and push (stale lease,
 * non-fast-forward). Auth / network / refusal errors return false so we
 * don't loop on a genuinely broken setup.
 */
export function isPushRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes('stale info') ||
    m.includes('non-fast-forward') ||
    m.includes('fetch first') ||
    m.includes('[rejected]')
  );
}

async function escalate(repo: Repo, prNumber: number, reason: string): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  await gh.issues
    .addLabels({
      owner,
      repo: name,
      issue_number: prNumber,
      labels: [OBELISK_LABELS.needsHuman],
    })
    .catch(() => undefined);

  const body =
    reason === 'rebase_conflict'
      ? "Obelisk couldn't auto-rebase this PR against the default branch — there's a conflict that needs human resolution. Once you've rebased manually, remove the `obelisk:needs-human` label and Obelisk will resume monitoring."
      : reason === 'max_attempts_reached'
        ? `Obelisk has tried to auto-rebase this PR ${ESCALATION_MAX_ATTEMPTS} times without success. Marking for human review.`
        : `Obelisk needs human review on this PR (reason: ${reason}).`;

  await gh.issues
    .createComment({
      owner,
      repo: name,
      issue_number: prNumber,
      body,
    })
    .catch(() => undefined);
}

function parseRunIdFromBranch(branch: string): string | null {
  if (!branch.startsWith('obelisk/')) return null;
  const id = branch.slice('obelisk/'.length);
  return id.length > 0 ? id : null;
}

function countRebaseAttempts(prNumber: number): number {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_rebase_attempt'
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return row?.c ?? 0;
}

function mostRecentRebaseAttemptAt(prNumber: number): number | null {
  const row = getDb()
    .prepare<[number], { at: string | null }>(
      `SELECT at FROM audit_log
        WHERE kind = 'pr_rebase_attempt'
          AND json_extract(payload, '$.prNumber') = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(prNumber);
  if (!row?.at) return null;
  const ms = new Date(row.at).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function hasActiveRunForTaskRef(repoId: string, taskRef: string, excludeRunId: string): boolean {
  const row = getDb()
    .prepare<[string, string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM runs
        WHERE repo_id = ? AND task_ref = ? AND id != ?
          AND state IN ('queued','running','publishing','paused')`,
    )
    .get(repoId, taskRef, excludeRunId);
  return (row?.c ?? 0) > 0;
}

function logSkip(prNumber: number, reason: string): void {
  // Auto-merge isn't tied to a specific agent run, so the audit row uses
  // the synthetic 'system' run-id.
  appendAudit({
    runId: 'system',
    kind: 'auto_merge_skipped',
    payload: { pr: prNumber, reason },
  });
}

function logMerge(prNumber: number): void {
  appendAudit({
    runId: 'system',
    kind: 'auto_merge_merged',
    payload: { pr: prNumber },
  });
}

function logMergeQueueEnqueued(prNumber: number): void {
  appendAudit({
    runId: 'system',
    kind: 'auto_merge_enqueued',
    payload: { pr: prNumber, via: 'merge_queue' },
  });
}

function logRebaseAttempt(
  prNumber: number,
  outcome: 'success' | 'conflict' | 'error' | 'escalated',
  detail: Record<string, unknown>,
): void {
  appendAudit({
    runId: 'system',
    kind: 'pr_rebase_attempt',
    payload: { prNumber, outcome, ...detail },
  });
}

/* ---------- CI-failure auto-fix retry (Phase 2.3) ---------- */

/**
 * One-shot retry per Obelisk-authored PR: when CI fails and the PR is
 * otherwise mergeable, fetch the failure log (truncated), spawn the
 * originating agent with a `resumeContext`, and let it append a fix-up
 * commit. After one attempt — success OR failure — escalation kicks in
 * the next time CI is observed failing on the same PR.
 *
 * Cooldown is permanent (no time window) and tracked via `audit_log` rows
 * with `kind='pr_ci_retry'`. This is intentional: an LLM that couldn't
 * fix a CI failure once will likely chase the same red herring again.
 */
export async function retryFailedCiPrs(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  const { data: prs } = await gh.pulls.list({
    owner,
    repo: name,
    state: 'open',
    per_page: 50,
  });

  for (const pr of prs) {
    if (!pr.head.ref.startsWith('obelisk/')) continue;
    if (pr.draft) continue;

    let detail;
    try {
      detail = await gh.pulls.get({ owner, repo: name, pull_number: pr.number });
    } catch {
      continue;
    }
    if (detail.data.mergeable === null) continue;
    // Only auto-retry when the PR's diff is otherwise clean — if it's also
    // dirty, the rebase sweep handles it first and a new CI run will
    // follow naturally.
    if (detail.data.mergeable_state !== 'clean') continue;

    let checks;
    try {
      checks = await gh.checks.listForRef({
        owner,
        repo: name,
        ref: pr.head.sha,
        per_page: 100,
      });
    } catch {
      continue;
    }

    const failed = checks.data.check_runs.filter(
      (r) => r.status === 'completed' && r.conclusion === 'failure',
    );
    if (failed.length === 0) continue;

    if (hasPriorCiRetryAttempt(pr.number)) {
      // Already tried once — escalate (idempotent, only sends comment if
      // not already escalated).
      if (!hasPriorCiRetryEscalation(pr.number)) {
        await escalate(repo, pr.number, 'ci_retry_exhausted');
        logCiRetryAttempt(pr.number, 'escalated', { reason: 'cooldown_hit' });
      }
      continue;
    }

    const runId = parseRunIdFromBranch(pr.head.ref);
    if (!runId) {
      logCiRetryAttempt(pr.number, 'aborted', { reason: 'no_run_id_in_branch' });
      continue;
    }
    const originalRun = getRun(runId);
    if (!originalRun) {
      logCiRetryAttempt(pr.number, 'aborted', { reason: 'original_run_missing' });
      continue;
    }
    if (!originalRun.taskRef) {
      logCiRetryAttempt(pr.number, 'aborted', { reason: 'no_task_ref' });
      continue;
    }
    if (hasActiveRunForTaskRef(repo.id, originalRun.taskRef, runId)) {
      // Either an in-flight retry already exists, or another agent is
      // working the same issue — leave it alone.
      continue;
    }

    const failureLog = await fetchFailureLog(gh, owner, name, failed).catch(() => '');
    if (!failureLog) {
      logCiRetryAttempt(pr.number, 'aborted', { reason: 'log_fetch_failed' });
      continue;
    }

    logCiRetryAttempt(pr.number, 'attempt', { runId, taskRef: originalRun.taskRef });

    const resumeContext: ResumeContext = {
      kind: 'ci_failure',
      prNumber: pr.number,
      prBranch: pr.head.ref,
      originalRunId: runId,
      taskRef: originalRun.taskRef,
      agentName: originalRun.agentName as AgentName,
      ...(detail.data.body ? { originalTitle: detail.data.title } : { originalTitle: pr.title }),
      ...(extractIssueNumberFromTaskRef(originalRun.taskRef)
        ? { githubNumber: extractIssueNumberFromTaskRef(originalRun.taskRef)! }
        : {}),
      failureLog,
    };

    try {
      const result = await runAgent({
        repoId: repo.id,
        agentName: originalRun.agentName as AgentName,
        ...(originalRun.agentId ? { agentId: originalRun.agentId } : {}),
        trigger: 'manual',
        resumeContext,
      });
      logCiRetryAttempt(pr.number, result.finalState === 'done' ? 'success' : 'failed', {
        retryRunId: result.runId,
        finalState: result.finalState,
        ...(result.reason ? { reason: result.reason } : {}),
      });
      if (result.finalState !== 'done') {
        await escalate(repo, pr.number, 'ci_retry_failed');
      }
    } catch (e) {
      logCiRetryAttempt(pr.number, 'failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      await escalate(repo, pr.number, 'ci_retry_dispatch_failed');
    }
  }
}

async function fetchFailureLog(
  gh: NonNullable<Awaited<ReturnType<typeof getGithub>>>,
  owner: string,
  repo: string,
  failedChecks: { name: string; details_url?: string | null }[],
): Promise<string> {
  const parts: string[] = [];
  let used = 0;

  for (const check of failedChecks) {
    if (used >= CI_RETRY_LOG_BUDGET) break;
    // The check's details_url for an Actions job is of the form
    // `/actions/runs/<run_id>/job/<job_id>`. We pull job_id directly so we
    // can call `downloadJobLogsForWorkflowJob` — that endpoint returns
    // PLAINTEXT (vs `downloadWorkflowRunLogs` which returns a zip the
    // caller must extract). The previous implementation handed the LLM
    // raw zip bytes interpreted as utf-8, which was useless.
    const jobId = parseJobIdFromDetailsUrl(check.details_url ?? null);
    if (!jobId) {
      parts.push(
        `### ${check.name}\n(no log download available — third-party CI or missing job id)`,
      );
      continue;
    }
    let logText: string;
    try {
      // Octokit's confusingly-named `downloadJobLogsForWorkflowRun` is the
      // method that calls `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`
      // (plaintext output). The method name is a docs quirk — it operates
      // on a job_id, not a workflow run id.
      const resp = await gh.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      });
      logText = decodeJobLog(resp.data);
    } catch (e) {
      parts.push(
        `### ${check.name}\n(log fetch failed: ${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    const tail = lastNLines(logText, CI_RETRY_LOG_LINES_PER_JOB);
    const block = `### ${check.name}\n${tail}`;
    const remaining = CI_RETRY_LOG_BUDGET - used;
    const sliced = block.length > remaining ? `${block.slice(0, remaining)}\n…(truncated)` : block;
    parts.push(sliced);
    used += sliced.length;
  }

  return parts.join('\n\n');
}

/**
 * Pull a numeric job id out of a check-run's details_url. Examples:
 *   https://github.com/o/r/actions/runs/12345/job/67890     → 67890
 *   https://github.com/o/r/actions/runs/12345/jobs/67890    → 67890
 *   https://example.com/circle-ci/build/12                  → null
 *
 * Exported for unit testing — the regex shape is the only thing standing
 * between the LLM and the right log lines, so it earns its own assertions.
 */
export function parseJobIdFromDetailsUrl(url: string | null): number | null {
  if (!url) return null;
  const match = url.match(/\/jobs?\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Octokit's shim for `downloadJobLogsForWorkflowJob` returns either a
 * string, an ArrayBuffer, or a Node Buffer depending on transport. The
 * endpoint serves plaintext (no zip), so we just normalize to a string
 * without losing data.
 */
export function decodeJobLog(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return '';
}

function lastNLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function hasPriorCiRetryAttempt(prNumber: number): boolean {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_ci_retry'
          AND json_extract(payload, '$.outcome') IN ('attempt','success','failed')
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return (row?.c ?? 0) > 0;
}

function hasPriorCiRetryEscalation(prNumber: number): boolean {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_ci_retry'
          AND json_extract(payload, '$.outcome') = 'escalated'
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return (row?.c ?? 0) > 0;
}

function extractIssueNumberFromTaskRef(taskRef: string): number | null {
  const match = taskRef.match(/^issue#(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function logCiRetryAttempt(
  prNumber: number,
  outcome: 'attempt' | 'success' | 'failed' | 'aborted' | 'escalated',
  detail: Record<string, unknown>,
): void {
  appendAudit({
    runId: 'system',
    kind: 'pr_ci_retry',
    payload: { prNumber, outcome, ...detail },
  });
}
