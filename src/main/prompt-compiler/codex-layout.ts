import { resolveRunnerModel } from '../runners/effective-default';
import type { CompileInput, CompiledPrompt } from './types';

/**
 * Codex layout:
 *  - Skills inlined into userMessage as fenced sections under `## Skills`.
 *  - System prompt prepended to userMessage (Codex CLI doesn't take a
 *    separate system-prompt file).
 *  - userMessage piped to `codex exec` via stdin (no positional prompt arg).
 *  - Sandbox + model picked via flags; reasoning effort set via `-c` override.
 */
export function compileCodex(input: CompileInput): CompiledPrompt {
  const systemBlock = renderSystem(input);
  const skillsBlock = renderSkills(input);
  const taskBlock = renderTask(input);

  const userMessage = [systemBlock, skillsBlock, taskBlock].join('\n\n---\n\n');

  return {
    systemPrompt: '', // Codex inlines the system block
    userMessage,
    attachments: [],
    runnerArgs: renderRunnerArgs(input),
    contentHash: '', // filled in by index.ts
  };
}

function renderSystem(input: CompileInput): string {
  const { agent, permissions } = input;
  return [
    `# Role: ${agent.name}`,
    '',
    `## Mission`,
    agent.mission,
    '',
    `## Instructions`,
    agent.body,
    '',
    `## Permissions`,
    `- mode: ${permissions.mode}`,
    `- can_create_issues: ${permissions.canCreateIssues}`,
    `- can_open_prs: ${permissions.canOpenPRs}`,
    `- can_merge_prs: ${permissions.canMergePRs}`,
  ].join('\n');
}

function renderSkills(input: CompileInput): string {
  if (input.skills.length === 0) return '## Skills\n\n(none loaded)';
  const blocks = input.skills.map((s) => `### Skill: ${s.name}\n\n${s.body}`);
  return ['## Skills', '', ...blocks].join('\n\n');
}

function renderTask(input: CompileInput): string {
  const { task, repo } = input;
  const planBlock = task.assignedPlan
    ? [
        '## Assigned test plan',
        `Plan: ${task.assignedPlan.name} (id: ${task.assignedPlan.id})`,
        '',
        'Execute every test case below. For each case that fails, emit a finding whose',
        '`case_id` field matches the id from the plan so the user can map findings back',
        'to specific cases.',
        '',
        task.assignedPlan.body,
        '',
      ].join('\n')
    : '';
  return [
    `## Task: ${task.ref}`,
    `Kind: ${task.kind}`,
    task.githubNumber ? `GitHub: #${task.githubNumber}` : '',
    '',
    '## Context',
    task.context,
    '',
    planBlock,
    '## Repository',
    `Full name: ${repo.fullName}`,
    `Default branch: ${repo.defaultBranch}`,
    `Worktree: ${repo.worktreePath}`,
    `Languages: ${repo.languages.join(', ') || '(unknown)'}`,
    `Toolchain: ${repo.toolchain.join(', ') || '(unknown)'}`,
    '',
    '## README excerpt',
    repo.readmeExcerpt || '(no README detected)',
    '',
    '## QA Playbook',
    repo.qaPlaybookSummary || '(no qa/ directory)',
    '',
    '## Files changed since last successful run for this agent',
    repo.changedFilesSinceLastRun.length === 0
      ? '(first run, or no changes since last run)'
      : repo.changedFilesSinceLastRun.map((f) => `- ${f}`).join('\n'),
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function renderRunnerArgs(input: CompileInput): string[] {
  const reasoning =
    input.agent.name === 'feature-builder' || input.agent.name === 'bug-fixer' ? 'high' : 'medium';
  // codex exec reads the prompt from stdin (we pipe userMessage in the runner).
  // Reasoning effort isn't a top-level flag — set it via -c config override.
  // `--model` is only added when the user explicitly configured one in Settings.
  // Hardcoding model names breaks ChatGPT-account Codex sign-ins (which reject
  // `gpt-5` etc.) and rots fast as model versions ship.
  return buildCodexExecArgs({ sandbox: 'workspace-write', reasoning });
}

export function buildCodexExecArgs(opts: {
  sandbox: 'workspace-write' | 'read-only';
  reasoning: 'high' | 'medium' | 'low';
  /**
   * Per-call model override. `undefined` means "fall through to Settings",
   * a non-empty string means "use this exact model name", and `null`
   * (or the empty string after trim) means "force CLI default — skip the
   * --model flag entirely". The `null`/empty path is what unblocks
   * ChatGPT-account Codex sign-ins.
   */
  modelOverride?: string | null;
}): string[] {
  // `--skip-git-repo-check` is required for Obelisk: we run codex inside an
  // ephemeral per-run git worktree, which the user has never pre-trusted via
  // codex's interactive trust-prompt. Without this flag codex exits 1 with
  // "Not inside a trusted directory" before even reading the prompt.
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    opts.sandbox,
    '-c',
    `model_reasoning_effort="${opts.reasoning}"`,
  ];
  const resolved = resolveRunnerModel('codex', opts.modelOverride);
  if (resolved) {
    args.splice(1, 0, '--model', resolved);
  }
  return args;
}
