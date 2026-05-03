import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from 'electron';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo } from '../../shared/types';
import { getRepo } from '../db/repos';
import { listAgentsForRepo } from '../db/agents';
import { lockBacklogItem, unlockBacklogItem } from '../db/backlog';
import { createRun, transitionRun, getRun } from '../db/runs';
import { appendAudit } from '../logger/audit';
import { getAgentHandler } from '../agents/registry';
import { compile } from '../prompt-compiler';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { runnerFallback, classifyOutcome } from '../runners/fallback';
import type { CodingAgentRunner, RunResult } from '../runners/types';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { loadRunnerKey } from '../auth/token-store';
import { inferChangeKind } from '../evidence/infer-change-kind';
import { saveArtifact } from '../evidence/artifact-store';
import { checkEvidence } from '../evidence/check';
import { renderPrBody } from '../evidence/pr-body';
import { publish, clearInProgressLabel } from '../publisher';
import type { RepoSummary, Permissions } from '../prompt-compiler';

export interface RunAgentInput {
  repoId: string;
  agentName: AgentName;
  trigger: 'manual' | 'schedule' | 'webhook';
  /**
   * Inject a runner factory for tests (defaults to real Claude/Codex CLIs).
   */
  runnerFactory?: (kind: 'claude' | 'codex') => CodingAgentRunner;
  /**
   * Bypass the keychain for tests. Production reads from keytar.
   */
  apiKeyOverride?: string;
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

  const handler = getAgentHandler(input.agentName);
  if (!handler) {
    throw new ObeliskError(
      'AGENT_NOT_FOUND',
      `Agent '${input.agentName}' has no implementation in v0.1`,
      'Bug Fixer is the only Phase 4 agent; the rest land in Phases 5-8.',
    );
  }

  // 1) Pick a task.
  const selected = await handler.selectTask({ repo, defaultRunner: repo.defaultRunner });
  if (!selected) {
    return { runId: '', finalState: 'done', reason: 'nothing to do' };
  }

  // 2) Pick a runner: per-task override → per-agent override → repo default.
  const agentRow = listAgentsForRepo(repo.id).find((a) => a.name === input.agentName);
  const runnerKind = selected.runnerOverride ?? agentRow?.runnerOverride ?? repo.defaultRunner;

  // 3) Create the run row + lock the backlog item.
  const run = createRun({
    repoId: repo.id,
    agentName: input.agentName,
    trigger: input.trigger,
    taskRef: selected.task.ref,
    runnerUsed: runnerKind,
  });
  if (selected.backlogItem) {
    lockBacklogItem(selected.backlogItem.id, run.id);
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

    // 5) Compile the prompt.
    const repoSummary = buildRepoSummary(repo, worktreeHandle.worktreePath);
    const permissions = permissionsForRepo(repo);
    const prompt = compile({
      agentName: input.agentName,
      runnerOverride: runnerKind,
      task: selected.task,
      repo: repoSummary,
      permissions,
      paths: {
        builtinAgentsDir: builtinAgentsDir(),
        builtinSkillsDir: builtinSkillsDir(),
        ...maybeRepoOverrideDirs(repo.localPath),
      },
    });
    appendAudit({
      runId: run.id,
      kind: 'reasoning',
      payload: { summary: 'compiled prompt', contentHash: prompt.contentHash },
    });

    // 6) Pick API key from keychain (or test override).
    const apiKey = input.apiKeyOverride ?? (await loadRunnerKey(runnerKind));
    if (!apiKey) {
      throw new ObeliskError(
        'AUTH_REQUIRED',
        `No API key set for ${runnerKind}. Open Settings to add one.`,
      );
    }

    // 7) Run with auto-fallback policy.
    const runResult = await runWithFallback({
      runId: run.id,
      taskRef: selected.task.ref,
      preferredRunner: runnerKind,
      factory,
      worktreePath: worktreeHandle.worktreePath,
      prompt,
      timeoutMs: agentRow?.timeoutMs ?? 30 * 60 * 1000,
      apiKey: {
        name: runnerKind === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
        value: apiKey,
      },
    });

    if (!runResult.result.ok) {
      const errorCode = errorCodeForReason(runResult.result.reason);
      appendAudit({
        runId: run.id,
        kind: 'state',
        payload: {
          from: 'running',
          to: 'failed',
          reason: runResult.result.reason,
          detail: runResult.result.detail,
        },
      });
      transitionRun(run.id, 'failed', {
        errorCode,
        outputSummary: runResult.result.detail.slice(0, 500),
        runnerUsed: runResult.runnerUsed,
        fallbackUsed: runResult.fallbackUsed,
      });
      return { runId: run.id, finalState: 'failed', reason: runResult.result.reason };
    }

    // 8) Evidence: capture the patch + reasoning, infer change kind, check.
    transitionRun(run.id, 'publishing', {
      runnerUsed: runResult.runnerUsed,
      fallbackUsed: runResult.fallbackUsed,
    });

    saveArtifact({
      runId: run.id,
      repoId: repo.id,
      kind: 'patch',
      filename: 'patch.diff',
      contents: runResult.result.patch.diff,
    });
    saveArtifact({
      runId: run.id,
      repoId: repo.id,
      kind: 'reasoning',
      filename: 'reasoning.md',
      contents: runResult.result.reasoning,
    });
    // Phase 4 stub: a synthetic test_output artifact records that the runner
    // claimed tests passed. Phase 6+ wires real test extraction (testsRun).
    saveArtifact({
      runId: run.id,
      repoId: repo.id,
      kind: 'test_output',
      filename: 'test-output.txt',
      contents:
        runResult.result.testsRun
          .map((t) => `$ ${t.command}\nexit ${t.exitCode}\n${t.summary}`)
          .join('\n\n') || '(test runner output not yet extracted in Phase 4)',
    });
    if (input.agentName === 'bug-fixer') {
      // Bug Fixer's Prove-It Pattern means the failing test is part of the
      // patch. We tag it explicitly for the evidence checker.
      saveArtifact({
        runId: run.id,
        repoId: repo.id,
        kind: 'failing_test_diff',
        filename: 'failing-test.diff',
        contents: runResult.result.patch.diff,
      });
    }

    const inferred = inferChangeKind({
      agentName: input.agentName,
      filesChanged: runResult.result.patch.filesChanged,
    });
    const evidence = checkEvidence({
      runId: run.id,
      changeKind: inferred.kind,
      inferred,
    });
    appendAudit({
      runId: run.id,
      kind: 'evidence_check',
      payload: { result: evidence.ok ? 'pass' : 'fail', missing: evidence.missing },
    });

    if (!evidence.ok) {
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

    // 9) Publish via agent-supplied plan.
    const plan = handler.interpretResult({
      repo,
      task: selected.task,
      runResult: runResult.result,
    });
    if (plan.kind === 'pr') {
      // Fill in the head branch + the rendered PR body.
      const body = renderPrBody({
        agentName: input.agentName,
        runId: run.id,
        taskRef: selected.task.ref,
        summary: oneLine(runResult.result.reasoning),
        reasoning: runResult.result.reasoning,
        evidence,
      });
      plan.head = worktreeHandle.branch;
      plan.body = body;
    }

    const published = await publish({
      repo,
      runId: run.id,
      worktreePath: worktreeHandle.worktreePath,
      branch: worktreeHandle.branch,
      agentName: input.agentName,
      plan,
      commitSubject: plan.kind === 'pr' ? plan.title : `chore: ${selected.task.ref}`,
      ...(selected.task.githubNumber ? { sourceIssueNumber: selected.task.githubNumber } : {}),
    });

    let outputSummary = '';
    let result: RunAgentOutput;
    if (published.kind === 'pr') {
      outputSummary = `Opened PR #${published.prNumber}`;
      result = { runId: run.id, finalState: 'done', prNumber: published.prNumber };
    } else if (published.kind === 'issue') {
      outputSummary = `Filed issue #${published.issueNumber}`;
      result = { runId: run.id, finalState: 'done', issueNumber: published.issueNumber };
    } else if (published.kind === 'review') {
      outputSummary = `Posted review on PR #${published.prNumber}`;
      result = { runId: run.id, finalState: 'done', prNumber: published.prNumber };
    } else {
      outputSummary = `Noop: ${published.reason}`;
      result = { runId: run.id, finalState: 'done', reason: published.reason };
    }

    transitionRun(run.id, 'done', {
      outputSummary,
      runnerUsed: runResult.runnerUsed,
      fallbackUsed: runResult.fallbackUsed,
    });

    return result;
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
  prompt: import('../prompt-compiler').CompiledPrompt;
  timeoutMs: number;
  apiKey: { name: string; value: string };
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
    const abortController = new AbortController();
    const result = await impl.run(
      {
        worktreePath: input.worktreePath,
        prompt: input.prompt,
        apiKeyEnv: input.apiKey,
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
  // Phase 4 produces a deterministic minimal summary. Phase 5 enriches this
  // with real README parsing, framework detection, and changed-files since
  // last successful run for this agent.
  return {
    fullName: repo.githubFullName,
    defaultBranch: repo.defaultBranch,
    worktreePath,
    readmeExcerpt: '',
    languages: [],
    toolchain: [],
    changedFilesSinceLastRun: [],
    qaPlaybookSummary: '',
  };
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
