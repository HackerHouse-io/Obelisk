import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { walkMarkdownFiles } from '../util/walk-markdown';
import { app } from 'electron';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo } from '../../shared/types';
import { getRepo } from '../db/repos';
import { listAgentsForRepo, getAgent } from '../db/agents';
import { lockBacklogItem, unlockBacklogItem } from '../db/backlog';
import { attachRunToPrReviewClaim, releasePrReviewClaim } from '../db/pr-review-claims';
import { createRun, transitionRun, getRun } from '../db/runs';
import { appendAudit } from '../logger/audit';
import { getAgentHandler } from '../agents/registry';
import { compile } from '../prompt-compiler';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { effectiveDefaultRunner } from '../runners/effective-default';
import { runnerFallback, classifyOutcome } from '../runners/fallback';
import type { CodingAgentRunner, RunResult } from '../runners/types';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { inferChangeKind } from '../evidence/infer-change-kind';
import { learnFromPatch } from '../agents/playbook-learner';
import { getPlaybookDraft, quickRegeneratePlaybook } from '../agents/playbook-bootstrapper/publish';
import { simpleGit } from 'simple-git';
import { saveArtifact } from '../evidence/artifact-store';
import { checkEvidence } from '../evidence/check';
import { renderPrBody } from '../evidence/pr-body';
import { publish, clearInProgressLabel } from '../publisher';
import type { RepoSummary, Permissions } from '../prompt-compiler';

export interface RunAgentInput {
  repoId: string;
  agentName: AgentName;
  /**
   * Specific instance to attribute this run to. When omitted (legacy callers
   * or schedule paths that haven't been migrated yet), the orchestrator picks
   * the first agent row matching `agentName` for backward compatibility.
   */
  agentId?: string;
  trigger: 'manual' | 'schedule' | 'webhook';
  /**
   * Optional hint passed to the agent's `selectTask`. Used by agents that
   * support targeting a specific task (e.g. iOS QA Pilot's `flow:<id>`).
   */
  taskId?: string;
  /**
   * Inject a runner factory for tests (defaults to real Claude/Codex CLIs).
   */
  runnerFactory?: (kind: 'claude' | 'codex') => CodingAgentRunner;
}

export interface RunAgentOutput {
  runId: string;
  finalState: 'done' | 'failed' | 'paused';
  /** When publish succeeded. */
  prNumber?: number;
  issueNumber?: number;
  reason?: string;
}

const DEFAULT_FACTORIES = (kind: 'claude' | 'codex'): CodingAgentRunner =>
  kind === 'claude' ? new ClaudeCodeRunner() : new CodexRunner();

/**
 * The big glue: drive one agent run from selectTask through publish.
 *
 * Threading: every state transition broadcasts on the bus so the renderer
 * (Mission Control) repaints in real time. Failures are recorded, never
 * silently swallowed.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentOutput> {
  const factory = input.runnerFactory ?? DEFAULT_FACTORIES;

  const repo = getRepo(input.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${input.repoId} not found`);

  // Auto-refresh the QA playbook if the repo has advanced since the last
  // bootstrap. Cheap (heuristics only) and best-effort — failures don't
  // block the run.
  await maybeAutoRegenPlaybook(repo).catch(() => undefined);

  const handler = getAgentHandler(input.agentName);

  // Resolve which instance owns this run. Prefer the explicit agentId; fall
  // back to "first row of this type in the repo" for legacy paths.
  const agentRow = input.agentId
    ? getAgent(input.agentId)
    : (listAgentsForRepo(repo.id).find((a) => a.name === input.agentName) ?? null);

  // The user can change the global default in Settings; that's the source
  // of truth. The per-repo column is a fallback (used only if no global
  // setting has ever been written).
  const repoDefaultRunner = effectiveDefaultRunner(repo);

  // 1) Pick a task. multi-instance handlers use agentId to attribute claims.
  const selected = await handler.selectTask({
    repo,
    defaultRunner: repoDefaultRunner,
    taskId: input.taskId,
    ...(agentRow ? { agentId: agentRow.id } : {}),
  });
  if (!selected) {
    return { runId: '', finalState: 'done', reason: 'nothing to do' };
  }

  // 2) Pick a runner: per-task override → per-agent override → repo default.
  const runnerKind = selected.runnerOverride ?? agentRow?.runnerOverride ?? repoDefaultRunner;

  // 3) Create the run row + finalize any claims acquired during selectTask.
  const run = createRun({
    repoId: repo.id,
    agentName: input.agentName,
    agentId: agentRow?.id ?? null,
    trigger: input.trigger,
    taskRef: selected.task.ref,
    runnerUsed: runnerKind,
  });
  if (selected.backlogItem) {
    // Replaces the placeholder token used during atomic claim with the real
    // run id so the renderer can join backlog → runs.
    lockBacklogItem(selected.backlogItem.id, run.id);
  }
  if (selected.prReviewClaimId) {
    attachRunToPrReviewClaim(selected.prReviewClaimId, run.id);
  }

  appendAudit({
    runId: run.id,
    kind: 'state',
    payload: { from: 'queued', to: 'running', task: selected.task.ref },
  });
  transitionRun(run.id, 'running');

  let worktreeHandle: { worktreePath: string; branch: string } | null = null;
  try {
    // 4) Create worktree.
    worktreeHandle = await createWorktree({
      repoPath: repo.localPath,
      repoId: repo.id,
      runId: run.id,
      baseBranch: repo.defaultBranch,
    });
    transitionRun(run.id, 'running', { worktreePath: worktreeHandle.worktreePath });

    // 5) Compile the prompt. We compile per-runner because the layout differs
    //    (Claude takes --system-prompt-file + attachments; Codex inlines the
    //    system block into the user message). Memoize so a same-runner retry
    //    doesn't recompile, but a fallback to the other runner gets the right
    //    args / userMessage / attachments.
    const repoSummary = buildRepoSummary(repo, worktreeHandle.worktreePath);
    const permissions = permissionsForRepo(repo);
    const promptCache: Partial<
      Record<'claude' | 'codex', import('../prompt-compiler').CompiledPrompt>
    > = {};
    const compileFor = (
      runner: 'claude' | 'codex',
    ): import('../prompt-compiler').CompiledPrompt => {
      const cached = promptCache[runner];
      if (cached) return cached;
      const compiled = compile({
        agentName: input.agentName,
        runnerOverride: runner,
        task: selected.task,
        repo: repoSummary,
        permissions,
        paths: {
          builtinAgentsDir: builtinAgentsDir(),
          builtinSkillsDir: builtinSkillsDir(),
          ...maybeRepoOverrideDirs(repo.localPath),
        },
      });
      promptCache[runner] = compiled;
      appendAudit({
        runId: run.id,
        kind: 'reasoning',
        payload: { summary: 'compiled prompt', runner, contentHash: compiled.contentHash },
      });
      return compiled;
    };
    // Eagerly compile the preferred runner so the audit log shows it before
    // the spawn audit lines.
    compileFor(runnerKind);

    // 6) Run with auto-fallback policy. The CLI authenticates itself —
    //    Obelisk doesn't pass credentials.
    const runResult = await runWithFallback({
      runId: run.id,
      taskRef: selected.task.ref,
      preferredRunner: runnerKind,
      factory,
      worktreePath: worktreeHandle.worktreePath,
      compileFor,
      timeoutMs: agentRow?.timeoutMs ?? 30 * 60 * 1000,
    });

    // Read-only agents (qa-hunter, manual-qa, pr-reviewer) report
    // `no_changes` as their normal success path; coerce that into an ok
    // result with an empty patch so downstream code treats it uniformly.
    const result = runResult.result;
    const isReadOnlyNoChanges =
      !result.ok && result.reason === 'no_changes' && handler.producesPatch === false;

    if (!result.ok && !isReadOnlyNoChanges) {
      const errorCode = errorCodeForReason(result.reason);
      appendAudit({
        runId: run.id,
        kind: 'state',
        payload: {
          from: 'running',
          to: 'failed',
          reason: result.reason,
          detail: result.detail,
        },
      });
      transitionRun(run.id, 'failed', {
        errorCode,
        outputSummary: result.detail.slice(0, 500),
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'failed', reason: result.reason };
    }

    const ok = result.ok
      ? result
      : { ok: true as const, patch: { diff: '', filesChanged: [] }, testsRun: [], reasoning: '' };

    // 8) Capture artifacts + (for PR-opening agents) check the Evidence Pack.
    transitionRun(run.id, 'publishing', {
      runnerUsed: runResult.runnerUsed,
      fallbackUsed: runResult.fallbackUsed,
    });

    if (handler.producesPatch) {
      saveArtifact({
        runId: run.id,
        repoId: repo.id,
        kind: 'patch',
        filename: 'patch.diff',
        contents: ok.patch.diff,
      });
      // Best-effort: append newly-discovered flows to qa/critical-flows.md.
      // Failures are silent — the playbook is non-critical to the run.
      try {
        const learned = learnFromPatch({ repo, filesChanged: ok.patch.filesChanged });
        if (learned.appendedFlows.length > 0) {
          appendAudit({
            runId: run.id,
            kind: 'reasoning',
            payload: {
              summary: 'playbook learner',
              appendedFlows: learned.appendedFlows,
            },
          });
        }
      } catch {
        // ignore — learner is best-effort
      }
    }
    saveArtifact({
      runId: run.id,
      repoId: repo.id,
      kind: 'reasoning',
      filename: 'reasoning.md',
      contents: ok.reasoning || '(no reasoning emitted)',
    });
    saveArtifact({
      runId: run.id,
      repoId: repo.id,
      kind: 'test_output',
      filename: 'test-output.txt',
      contents:
        ok.testsRun.map((t) => `$ ${t.command}\nexit ${t.exitCode}\n${t.summary}`).join('\n\n') ||
        '(no test runner output extracted)',
    });
    if (input.agentName === 'bug-fixer') {
      // Bug Fixer's Prove-It Pattern means the failing test is part of the
      // patch. Tag it explicitly so the evidence check sees it.
      saveArtifact({
        runId: run.id,
        repoId: repo.id,
        kind: 'failing_test_diff',
        filename: 'failing-test.diff',
        contents: ok.patch.diff,
      });
    }

    const inferred = inferChangeKind({
      agentName: input.agentName,
      filesChanged: ok.patch.filesChanged,
    });
    const evidence = checkEvidence({
      runId: run.id,
      changeKind: inferred.kind,
      inferred,
    });
    appendAudit({
      runId: run.id,
      kind: 'evidence_check',
      payload: {
        result: evidence.ok ? 'pass' : 'fail',
        missing: evidence.missing,
        skipped: handler.skipsEvidenceGate,
      },
    });

    if (!handler.skipsEvidenceGate && !evidence.ok) {
      transitionRun(run.id, 'paused', {
        errorCode: 'EVIDENCE_INCOMPLETE',
        outputSummary: `Missing: ${evidence.missing.join(', ')}`,
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return {
        runId: run.id,
        finalState: 'paused',
        reason: 'EVIDENCE_INCOMPLETE',
      };
    }

    // 9) Publish via agent-supplied plan(s).
    const planOrPlans = await handler.interpretResult({
      repo,
      task: selected.task,
      runResult: ok,
      runId: run.id,
    });
    const plans = Array.isArray(planOrPlans) ? planOrPlans : [planOrPlans];

    if (plans.length === 0) {
      const summary = 'agent produced no actionable findings';
      appendAudit({ runId: run.id, kind: 'state', payload: { outcome: 'noop', reason: summary } });
      transitionRun(run.id, 'done', {
        outputSummary: summary,
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'done', reason: summary };
    }

    // Observe-mode preview: PR-opening agents ALWAYS need writes; issue-only
    // agents (skipsEvidenceGate=true) preview to audit_log instead.
    if (handler.skipsEvidenceGate && repo.mode === 'observe') {
      for (const plan of plans) {
        appendAudit({
          runId: run.id,
          kind: 'preview',
          payload: plan,
        });
      }
      transitionRun(run.id, 'done', {
        outputSummary: `Previewed ${plans.length} finding${plans.length === 1 ? '' : 's'} (observe mode)`,
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'done', reason: 'previewed' };
    }

    // Iterate plans. PR plans get the rendered Evidence body filled in.
    const published: Awaited<ReturnType<typeof publish>>[] = [];
    const failures: string[] = [];
    for (const plan of plans) {
      try {
        if (plan.kind === 'pr') {
          plan.head = worktreeHandle.branch;
          plan.body = renderPrBody({
            agentName: input.agentName,
            runId: run.id,
            taskRef: selected.task.ref,
            summary: oneLine(ok.reasoning),
            reasoning: ok.reasoning,
            evidence,
          });
        }
        const result = await publish({
          repo,
          runId: run.id,
          worktreePath: worktreeHandle.worktreePath,
          branch: worktreeHandle.branch,
          agentName: input.agentName,
          plan,
          commitSubject: plan.kind === 'pr' ? plan.title : `chore: ${selected.task.ref}`,
          ...(selected.task.githubNumber ? { sourceIssueNumber: selected.task.githubNumber } : {}),
        });
        published.push(result);
        appendAudit({ runId: run.id, kind: 'published', payload: result });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push(message);
        appendAudit({ runId: run.id, kind: 'publish_failed', payload: { plan, error: message } });
      }
    }

    if (published.length === 0) {
      throw new Error(failures[0] ?? 'publish failed for every plan');
    }

    const outputSummary = describeOutcomes(published);
    transitionRun(run.id, 'done', {
      outputSummary,
      runnerUsed: runResult.runnerUsed,
      fallbackUsed: runResult.fallbackUsed,
    });

    const pr = published.find((r) => r.kind === 'pr');
    const issue = published.find((r) => r.kind === 'issue');
    return {
      runId: run.id,
      finalState: 'done',
      ...(pr ? { prNumber: pr.prNumber } : {}),
      ...(issue ? { issueNumber: issue.issueNumber } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    appendAudit({
      runId: run.id,
      kind: 'state',
      payload: { from: 'running', to: 'failed', error: message },
    });
    transitionRun(run.id, 'failed', {
      errorCode: e instanceof ObeliskError ? e.code : 'INTERNAL',
      outputSummary: message.slice(0, 500),
    });
    return { runId: run.id, finalState: 'failed', reason: message };
  } finally {
    if (selected?.backlogItem) {
      unlockBacklogItem(selected.backlogItem.id);
    }
    if (selected?.prReviewClaimId) {
      const finalState = getRun(run.id)?.state;
      const result: 'done' | 'failed' | 'paused' =
        finalState === 'done' ? 'done' : finalState === 'paused' ? 'paused' : 'failed';
      releasePrReviewClaim(selected.prReviewClaimId, result);
    }
    if (worktreeHandle) {
      const finalRun = getRun(run.id);
      // Retain the worktree on failure (24h debug window — actual reaper
      // lands in Phase 10).
      if (finalRun?.state === 'done') {
        await destroyWorktree(repo.localPath, worktreeHandle.worktreePath).catch(() => undefined);
      }
    }
    if (selected.task.githubNumber) {
      await clearInProgressLabel(repo, selected.task.githubNumber).catch(() => undefined);
    }
  }
}

/* ---------- internals ---------- */

interface FallbackInput {
  runId: string;
  taskRef: string;
  preferredRunner: 'claude' | 'codex';
  factory: (k: 'claude' | 'codex') => CodingAgentRunner;
  worktreePath: string;
  compileFor: (runner: 'claude' | 'codex') => import('../prompt-compiler').CompiledPrompt;
  timeoutMs: number;
}

interface FallbackOutput {
  result: RunResult;
  runnerUsed: 'claude' | 'codex';
  fallbackUsed: boolean;
}

async function runWithFallback(input: FallbackInput): Promise<FallbackOutput> {
  let runner: 'claude' | 'codex' | null = input.preferredRunner;
  let lastResult: RunResult | null = null;
  let fallbackUsed = false;

  while (runner !== null) {
    const impl = input.factory(runner);
    const prompt = input.compileFor(runner);
    const abortController = new AbortController();
    const result = await impl.run(
      {
        worktreePath: input.worktreePath,
        prompt,
        timeoutMs: input.timeoutMs,
        onAudit: (line) => {
          appendAudit({
            runId: input.runId,
            kind: line.kind,
            payload: line.payload,
          });
        },
      },
      abortController.signal,
    );
    lastResult = result;

    const outcome = classifyOutcome(result.ok ? undefined : result.reason);
    runnerFallback.record(input.taskRef, runner, outcome);
    if (outcome !== 'fatal_fail') {
      return { result, runnerUsed: runner, fallbackUsed };
    }
    const next = runnerFallback.decide(input.taskRef, runner);
    if (next === runner) {
      // The policy says retry the same runner — go again.
      continue;
    }
    if (next === null) {
      return { result, runnerUsed: runner, fallbackUsed };
    }
    fallbackUsed = true;
    runner = next;
  }
  // Unreachable, but TypeScript wants a return.
  return { result: lastResult!, runnerUsed: input.preferredRunner, fallbackUsed };
}

function buildRepoSummary(repo: Repo, worktreePath: string): RepoSummary {
  return {
    fullName: repo.githubFullName,
    defaultBranch: repo.defaultBranch,
    worktreePath,
    readmeExcerpt: '',
    languages: [],
    toolchain: [],
    changedFilesSinceLastRun: [],
    qaPlaybookSummary: readQaPlaybookSummary(repo.localPath),
  };
}

const QA_SUMMARY_BUDGET = 16 * 1024;

function readQaPlaybookSummary(repoRoot: string): string {
  const files = walkMarkdownFiles(join(repoRoot, 'qa'));
  if (files.length === 0) return '';

  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    const block = `\n\n--- qa/${f.relPath} ---\n${f.contents.trim()}`;
    if (used + block.length > QA_SUMMARY_BUDGET) {
      parts.push('\n\n(truncated — playbook exceeds prompt budget)');
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('').trim();
}

async function maybeAutoRegenPlaybook(repo: Repo): Promise<void> {
  const draft = getPlaybookDraft(repo.id);
  if (!draft?.generatedAt) {
    // No prior bootstrap recorded → seed it now.
    await quickRegeneratePlaybook(repo);
    return;
  }
  let headIso: string | null = null;
  try {
    const git = simpleGit(repo.localPath);
    const log = await git.log({ maxCount: 1 });
    headIso = log.latest?.date ?? null;
  } catch {
    return;
  }
  if (!headIso) return;
  if (new Date(headIso).getTime() > new Date(draft.generatedAt).getTime()) {
    await quickRegeneratePlaybook(repo);
  }
}

function permissionsForRepo(repo: Repo): Permissions {
  return {
    mode: repo.mode,
    canCreateIssues: repo.mode === 'issues' || repo.mode === 'prs' || repo.mode === 'automerge',
    canOpenPRs: repo.mode === 'prs' || repo.mode === 'automerge',
    canMergePRs: repo.mode === 'automerge',
  };
}

function builtinAgentsDir(): string {
  try {
    return resolve(app.getAppPath(), 'agents');
  } catch {
    return resolve(process.cwd(), 'agents');
  }
}

function builtinSkillsDir(): string {
  try {
    return resolve(app.getAppPath(), 'skills');
  } catch {
    return resolve(process.cwd(), 'skills');
  }
}

function maybeRepoOverrideDirs(repoPath: string): {
  repoAgentsDir?: string;
  repoSkillsDir?: string;
} {
  const out: { repoAgentsDir?: string; repoSkillsDir?: string } = {};
  const agents = resolve(repoPath, 'agents');
  const skills = resolve(repoPath, 'skills');
  if (existsSync(agents)) out.repoAgentsDir = agents;
  if (existsSync(skills)) out.repoSkillsDir = skills;
  return out;
}

function errorCodeForReason(reason: 'timeout' | 'crash' | 'non_zero_exit' | 'no_changes'): string {
  switch (reason) {
    case 'timeout':
      return 'TIMEOUT';
    case 'crash':
    case 'non_zero_exit':
      return 'INTERNAL';
    case 'no_changes':
      return 'INTERNAL';
  }
}

function oneLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function describeOutcomes(results: Awaited<ReturnType<typeof publish>>[]): string {
  const prs = results.filter((r) => r.kind === 'pr').length;
  const issues = results.filter((r) => r.kind === 'issue').length;
  const comments = results.filter((r) => r.kind === 'comment').length;
  const reviews = results.filter((r) => r.kind === 'review').length;
  const parts: string[] = [];
  if (issues) parts.push(`${issues} issue${issues === 1 ? '' : 's'}`);
  if (prs) parts.push(`${prs} PR${prs === 1 ? '' : 's'}`);
  if (comments) parts.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  if (reviews) parts.push(`${reviews} review${reviews === 1 ? '' : 's'}`);
  return parts.length === 0 ? 'noop' : `Published ${parts.join(', ')}`;
}
