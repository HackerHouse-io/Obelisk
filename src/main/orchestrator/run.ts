import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { walkMarkdownFiles } from '../util/walk-markdown';
import { app } from 'electron';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo } from '../../shared/types';
import { getRepo } from '../db/repos';
import { listAgentsForRepo, getAgent, updateAgent } from '../db/agents';
import { lockBacklogItem, unlockBacklogItem } from '../db/backlog';
import { attachRunToPrReviewClaim, releasePrReviewClaim } from '../db/pr-review-claims';
import { createRun, transitionRun, getRun } from '../db/runs';
import { insertPreview } from '../db/previews';
import { appendAudit } from '../logger/audit';
import { getAgentHandler } from '../agents/registry';
import { compile } from '../prompt-compiler';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { effectiveDefaultRunner } from '../runners/effective-default';
import { runnerFallback, classifyOutcome } from '../runners/fallback';
import { isCancelled as runIsCancelled, registerRun, unregisterRun } from './active-runs';
import { CaseProgressTracker } from './case-progress';
import { broadcast } from '../ipc/bus';
import type { CodingAgentRunner, RunResult } from '../runners/types';
import { createWorktree, attachWorktree, destroyWorktree } from '../git/worktree';
import { inferChangeKind } from '../evidence/infer-change-kind';
import { learnFromPatch } from '../agents/playbook-learner';
import { getPlaybookDraft, quickRegeneratePlaybook } from '../agents/playbook-bootstrapper/publish';
import { simpleGit } from 'simple-git';
import { saveArtifact } from '../evidence/artifact-store';
import { checkEvidence } from '../evidence/check';
import { renderPrBody } from '../evidence/pr-body';
import { parseBugFixReport } from '../agents/bug-fixer';
import { publish, clearClaimSignals } from '../publisher';
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
   * One-shot runner override for this run only — does not persist on the
   * agent row. Used by the Test Plans "Run" popover so the user can pick a
   * runner for a single run without changing the agent's default.
   */
  runnerOverride?: 'claude' | 'codex';
  /**
   * One-shot model override for this run only. Empty string → "force CLI
   * default (skip --model flag)". Undefined → fall through to agent row →
   * Settings → CLI default.
   */
  modelOverride?: string;
  /**
   * Inject a runner factory for tests (defaults to real Claude/Codex CLIs).
   */
  runnerFactory?: (kind: 'claude' | 'codex') => CodingAgentRunner;
  /**
   * Fires once, immediately after the run row is created and the orchestrator
   * has committed to executing this run. Used by the `agents:run` IPC handler
   * to resolve as soon as we have a runId — without waiting for the (possibly
   * minutes-long) CLI invocation. Skipped when selectTask returns null (no
   * run row is created in that case).
   *
   * Receives `taskRef` and `taskContext` so the renderer can show "Bug Fixer
   * is working on issue#42 — Crash on cold start" the moment Run-now resolves.
   */
  onStarted?: (info: { runId: string; taskRef: string | null; taskContext: string | null }) => void;
  /**
   * Set by the CI-failure auto-fix loop. When provided, the orchestrator
   * bypasses `selectTask` (assembling the SelectedTask itself), attaches a
   * worktree to the existing PR branch, and tells the publisher to skip
   * `pulls.create`. See `agents/types.ts:ResumeContext`.
   */
  resumeContext?: import('../agents/types').ResumeContext;
}

export interface RunAgentOutput {
  runId: string;
  finalState: 'done' | 'failed' | 'paused' | 'cancelled';
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
  //    For resumed runs (CI-failure auto-fix) we bypass selectTask and build
  //    the SelectedTask from the resumeContext so the agent doesn't redraw
  //    a fresh issue from the backlog.
  const selected: import('../agents/types').SelectedTask | null = input.resumeContext
    ? buildResumedSelectedTask(input.resumeContext)
    : await handler.selectTask({
        repo,
        defaultRunner: repoDefaultRunner,
        trigger: input.trigger,
        taskId: input.taskId,
        ...(agentRow ? { agentId: agentRow.id } : {}),
      });
  if (!selected) {
    return { runId: '', finalState: 'done', reason: 'nothing to do' };
  }

  // 2) Pick a runner: per-call override (Test Plans popover) → per-task
  //    override (selectTask) → per-agent override (DB row) → repo default.
  const runnerKind =
    input.runnerOverride ??
    selected.runnerOverride ??
    agentRow?.runnerOverride ??
    repoDefaultRunner;

  // 3a) Pick the model the same way: explicit per-call override wins, then
  //     the persistent agent-row override, then Settings/CLI defaults via the
  //     compile() layer. `undefined` here means "let downstream resolve from
  //     Settings"; an explicit empty string means "force CLI default — skip
  //     the --model flag" (required for ChatGPT-account Codex sign-ins).
  const resolvedModelOverride: string | undefined =
    input.modelOverride !== undefined
      ? input.modelOverride
      : (agentRow?.modelOverride ?? undefined);

  // 3) Create the run row + finalize any claims acquired during selectTask.
  // createRun enforces per-task-ref single-flight (one run per `taskRef` at
  // a time per repo). If it throws, release any claims acquired above so we
  // don't leak a stuck backlog item or PR-review claim.
  let run;
  try {
    run = createRun({
      repoId: repo.id,
      agentName: input.agentName,
      agentId: agentRow?.id ?? null,
      trigger: input.trigger,
      taskRef: selected.task.ref,
      taskContext: selected.task.context ?? null,
      runnerUsed: runnerKind,
    });
  } catch (e) {
    if (selected.backlogItem) {
      unlockBacklogItem(selected.backlogItem.id);
    }
    if (selected.prReviewClaimId) {
      releasePrReviewClaim(selected.prReviewClaimId, 'failed');
    }
    throw e;
  }
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

  // Tell callers (the `agents:run` IPC handler) that the run is committed.
  // This unblocks the renderer's "Run now" button without making it wait
  // for the entire CLI invocation to complete (which can take minutes).
  // Errors thrown by the listener are swallowed — they're not allowed to
  // sabotage a run that's already past createRun.
  if (input.onStarted) {
    try {
      input.onStarted({
        runId: run.id,
        taskRef: selected.task.ref ?? null,
        taskContext: selected.task.context ?? null,
      });
    } catch {
      // ignore
    }
  }

  // Register the run in the active-runs map so `agents:cancel` can abort
  // the spawn. The AbortController flows through to the CLI runner via
  // runWithFallback below.
  const abortController = registerRun(run.id);

  let worktreeHandle: { worktreePath: string; branch: string } | null = null;
  let runInfra: import('../agents/types').RunInfra | null = null;
  try {
    // 4) Worktree. Resumed runs attach to the existing PR branch so the
    //    fix-up commit appends to it; fresh runs fork a new branch off the
    //    repo's default branch.
    if (input.resumeContext) {
      worktreeHandle = await attachWorktree({
        repoPath: repo.localPath,
        repoId: repo.id,
        slot: `${input.resumeContext.originalRunId}-resume-${run.id}`,
        branch: input.resumeContext.prBranch,
      });
    } else {
      worktreeHandle = await createWorktree({
        repoPath: repo.localPath,
        repoId: repo.id,
        runId: run.id,
        baseBranch: repo.defaultBranch,
      });
    }
    transitionRun(run.id, 'running', { worktreePath: worktreeHandle.worktreePath });

    // 4b) Agent-specific infrastructure setup — boot a simulator, start
    // an Appium server, etc. The teardown handle is invoked in the
    // `finally` block regardless of success/failure so we don't leak
    // child processes when the runner crashes. Skipped under vitest so
    // unit tests don't shell out to xcrun/appium during parallel runs.
    if (handler.preRun && !process.env['VITEST']) {
      runInfra = await handler.preRun({
        runId: run.id,
        selected,
        repo,
      });
    }

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
        ...(resolvedModelOverride !== undefined ? { modelOverride: resolvedModelOverride } : {}),
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
    //    Obelisk doesn't pass credentials. The shared abort signal lets
    //    `agents:cancel` terminate the spawn from the IPC layer.
    const caseTracker = new CaseProgressTracker((evt) => {
      // Persist a per-case audit row + broadcast so the Plan Progress tab
      // updates live. The renderer derives the per-case grid from these rows.
      appendAudit({
        runId: run.id,
        kind: 'case_progress',
        payload: {
          caseId: evt.caseId,
          status: evt.status,
          ...(evt.detail ? { detail: evt.detail } : {}),
        },
      });
      broadcast({
        type: 'run.caseProgress',
        runId: run.id,
        caseId: evt.caseId,
        status: evt.status,
      });
    });
    const runResult = await runWithFallback({
      runId: run.id,
      taskRef: selected.task.ref,
      preferredRunner: runnerKind,
      factory,
      worktreePath: worktreeHandle.worktreePath,
      compileFor,
      timeoutMs: agentRow?.timeoutMs ?? 30 * 60 * 1000,
      abortSignal: abortController.signal,
      caseTracker,
    });
    caseTracker.flush();

    // If the user clicked Stop while the runner was spawning, the runner's
    // result will look like a crash/no_changes/non_zero_exit — but we want
    // the run to land in `cancelled`, not `failed`. Detect that here before
    // any other failure-classification branch runs.
    if (runIsCancelled(run.id)) {
      appendAudit({
        runId: run.id,
        kind: 'state',
        payload: { from: 'running', to: 'cancelled', reason: 'user_cancelled' },
      });
      transitionRun(run.id, 'cancelled', {
        outputSummary: 'Stopped by the user.',
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'cancelled', reason: 'user_cancelled' };
    }

    // Read-only agents (qa-hunter, manual-qa, pr-reviewer) report
    // `no_changes` as their normal success path; coerce that into an ok
    // result with an empty patch so downstream code treats it uniformly.
    const result = runResult.result;
    const isReadOnlyNoChanges =
      !result.ok && result.reason === 'no_changes' && handler.producesPatch === false;

    if (!result.ok && !isReadOnlyNoChanges) {
      const errorCode = errorCodeForFailure(result.reason, result.detail);
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
      // Auth-required is terminal until the user signs in. Auto-pause the
      // owning agent immediately (skip the 3-strike circuit breaker) so we
      // don't burn cron tick after cron tick on a known-broken setup. Manual
      // triggers don't pause — the user is actively debugging.
      if (
        result.reason === 'auth_required' &&
        agentRow &&
        agentRow.enabled &&
        input.trigger !== 'manual'
      ) {
        try {
          updateAgent(agentRow.id, { enabled: false });
          appendAudit({
            runId: run.id,
            kind: 'agent_auto_paused',
            payload: {
              agentId: agentRow.id,
              agentName: agentRow.name,
              reason: 'login_required',
              runnerUsed: runResult.runnerUsed,
              detail: result.detail,
            },
          });
          broadcast({
            type: 'agent.autoPaused',
            repoId: repo.id,
            agentId: agentRow.id,
            agentName: agentRow.name,
            displayName: agentRow.displayName,
            reason: 'consecutive_failures',
            consecutiveFailures: 1,
            lastErrorCode: errorCode,
            lastErrorSummary: result.detail.slice(0, 200),
          });
        } catch {
          // Best-effort — if the auto-pause itself fails, the scheduler's
          // 3-strike breaker will catch us within a few minutes anyway.
        }
      }
      return { runId: run.id, finalState: 'failed', reason: result.reason };
    }

    const ok = result.ok
      ? result
      : {
          ok: true as const,
          patch: { diff: '', filesChanged: [] },
          testsRun: [],
          // CRITICAL: read-only agents (QA Hunter, Manual QA) emit their
          // findings on stdout, not as a patch. Without this passthrough the
          // orchestrator parses an empty string and drops every finding —
          // exactly the bug the user reported on HackerHouse-io/WealthLab,
          // where codex returned two real bugs that landed nowhere.
          reasoning: result.reasoning ?? '',
        };

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

    // Observe-mode preview path comes first so QA agents that produced zero
    // findings still get a friendly "Plan executed; no findings." summary
    // (the generic noop-summary below would otherwise win and confuse users).
    if (handler.skipsEvidenceGate && repo.mode === 'observe') {
      for (const plan of plans) {
        // Previews live in their own table now (previews + preview_markers,
        // see migration 005) so they survive deletion of the originating
        // run row. Schema has ON DELETE SET NULL on the run_id back-pointer.
        insertPreview({
          repoId: repo.id,
          runId: run.id,
          agentName: input.agentName,
          payload: plan,
        });
      }
      const summary =
        plans.length === 0
          ? 'Plan executed; no findings.'
          : plans.length === 1
            ? 'Filed 1 preview — review on Home.'
            : `Filed ${plans.length} previews — review on Home.`;
      transitionRun(run.id, 'done', {
        outputSummary: summary,
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'done', reason: 'previewed' };
    }

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

    // Iterate plans. PR plans get the rendered Evidence body filled in.
    const published: Awaited<ReturnType<typeof publish>>[] = [];
    const failures: string[] = [];
    for (const plan of plans) {
      try {
        if (plan.kind === 'pr') {
          plan.head = worktreeHandle.branch;
          // Bug-fixer runs are required to emit a structured
          // BEGIN_BUG_FIX_REPORT block at the end of their reasoning;
          // when present it powers the PR body's Root cause / Fix /
          // Test evidence sections instead of the LLM monologue. Falls
          // back to the legacy reasoning dump when the block is missing
          // (e.g. the agent stopped early with REPRO_FAILED).
          const bugFixReport =
            input.agentName === 'bug-fixer' ? parseBugFixReport(ok.reasoning) : null;
          const commits = await readCommitsOnBranch(
            worktreeHandle.worktreePath,
            repo.defaultBranch,
          ).catch(() => [] as { sha: string; subject: string }[]);
          plan.body = renderPrBody({
            agentName: input.agentName,
            runId: run.id,
            taskRef: selected.task.ref,
            summary: oneLine(ok.reasoning),
            reasoning: ok.reasoning,
            evidence,
            bugFixReport,
            commits,
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
          ...(input.resumeContext ? { existingPrNumber: input.resumeContext.prNumber } : {}),
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
    // If the user clicked Stop while this branch was running (e.g. inside
    // worktree cleanup or publish), surface it as `cancelled`, not `failed`.
    if (runIsCancelled(run.id)) {
      appendAudit({
        runId: run.id,
        kind: 'state',
        payload: { from: 'running', to: 'cancelled', reason: 'user_cancelled' },
      });
      transitionRun(run.id, 'cancelled', { outputSummary: 'Stopped by the user.' });
      return { runId: run.id, finalState: 'cancelled', reason: 'user_cancelled' };
    }
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
    // Always release the active-runs entry — this run is no longer cancelable.
    unregisterRun(run.id);
    // Tear down agent-specific infrastructure (Appium server, etc.) BEFORE
    // any other cleanup so the user doesn't see stale ports lingering.
    if (runInfra) {
      await runInfra.teardown().catch(() => undefined);
    }
    if (selected?.backlogItem) {
      unlockBacklogItem(selected.backlogItem.id);
    }
    if (selected?.prReviewClaimId) {
      const finalState = getRun(run.id)?.state;
      const result: 'done' | 'failed' | 'paused' =
        finalState === 'done'
          ? 'done'
          : finalState === 'paused'
            ? 'paused'
            : finalState === 'cancelled'
              ? 'paused'
              : 'failed';
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
    // Resume runs share the original issue's claim signals; the original
    // run's lifecycle still owns clearing them. Skipping here avoids
    // racing with a still-open original PR's label.
    if (selected.task.githubNumber && !input.resumeContext) {
      await clearClaimSignals(repo, selected.task.githubNumber).catch(() => undefined);
    }
  }
}

/**
 * Read the commits the runner produced on its branch (everything ahead
 * of the repo's default branch, oldest-first). Used by `renderPrBody`
 * to surface the commit list in the PR description so reviewers can
 * scan what got committed without expanding the diff.
 */
async function readCommitsOnBranch(
  worktreePath: string,
  defaultBranch: string,
): Promise<{ sha: string; subject: string }[]> {
  const git = simpleGit(worktreePath);
  // %h = abbreviated sha, %s = subject; tab-separated so subjects with
  // spaces stay intact.
  const out = await git.raw([
    'log',
    `${defaultBranch}..HEAD`,
    '--pretty=format:%H%x09%s',
    '--reverse',
  ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha: sha ?? '', subject: rest.join('\t') };
    });
}

/**
 * Assemble a SelectedTask for a CI-retry resumed run. The orchestrator uses
 * this in place of `handler.selectTask` so the retry doesn't pop a different
 * issue off the backlog.
 *
 * The failure log is spliced into `task.context` so the agent reads it from
 * the existing prompt path; no prompt-compiler surgery required.
 */
function buildResumedSelectedTask(
  ctx: import('../agents/types').ResumeContext,
): import('../agents/types').SelectedTask {
  const context = [
    `This run is a CI-failure retry for PR #${ctx.prNumber} (branch: ${ctx.prBranch}).`,
    `Original task: ${ctx.originalTitle}`,
    '',
    'Your job: write the SMALLEST fix-up commit that addresses the failing checks.',
    '- Do NOT rebase or rewrite history; just append a commit.',
    '- Do NOT open a new PR; the existing PR will pick up the new commit automatically.',
    '- If you cannot determine a safe fix, emit `BLOCKED ci_retry: <reason>` and stop.',
    '',
    '# Failing CI log (truncated)',
    ctx.failureLog,
  ].join('\n');

  return {
    task: {
      ref: ctx.taskRef,
      kind: 'bug',
      context,
      ...(ctx.githubNumber ? { githubNumber: ctx.githubNumber } : {}),
    },
  };
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
  /** Shared with the active-runs registry so user cancels reach the spawn. */
  abortSignal: AbortSignal;
  /** Streaming parser fed every stdout line so CASE_* markers fire live updates. */
  caseTracker: CaseProgressTracker;
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
          // Tee stdout into the case-progress tracker so CASE_* markers
          // surface as live audit rows + bus events for the Plan Progress
          // tab in Mission Control.
          if (line.kind === 'stdout' && typeof line.payload === 'string') {
            input.caseTracker.feedLine(line.payload);
          }
        },
      },
      input.abortSignal,
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

function errorCodeForFailure(
  reason: 'timeout' | 'crash' | 'non_zero_exit' | 'no_changes' | 'auth_required',
  detail: string,
): string {
  switch (reason) {
    case 'timeout':
      return 'TIMEOUT';
    case 'crash':
      return 'INTERNAL';
    case 'auth_required':
      return 'RUNNER_LOGIN_REQUIRED';
    case 'non_zero_exit':
      // The CLI runners format their detail strings with a "with no output"
      // suffix when neither stdout nor stderr was produced; that's almost
      // always an install/auth issue worth distinguishing from a crash.
      if (/with no output\b/i.test(detail)) return 'RUNNER_NO_OUTPUT';
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
