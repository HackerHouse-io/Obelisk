import { resolveRunnerModel } from '../runners/effective-default';
import type { CompileInput, CompiledPrompt, AttachmentFile } from './types';

/**
 * Claude Code layout:
 *  - Skills materialized as files at `.claude/skills/<name>/SKILL.md`
 *    (the `claude` CLI auto-loads from there).
 *  - System prompt passed via `--system-prompt-file` (the runner materializes
 *    it under `.claude/SYSTEM.md`).
 *  - userMessage piped via stdin; `-p` (print) makes claude non-interactive.
 *  - userMessage gets the task + repo summary; skills are NOT inlined here
 *    because the CLI loads them from the materialized files.
 */
export function compileClaude(input: CompileInput): CompiledPrompt {
  const attachments: AttachmentFile[] = input.skills.map((s) => ({
    path: `.claude/skills/${s.name}/SKILL.md`,
    contents: s.body,
  }));

  const settings = renderClaudeSettings(input);
  attachments.push({ path: '.claude/settings.json', contents: settings });

  return {
    systemPrompt: renderSystemPrompt(input),
    userMessage: renderUserMessage(input),
    attachments,
    runnerArgs: renderRunnerArgs(input),
    contentHash: '', // filled in by index.ts
  };
}

function renderSystemPrompt(input: CompileInput): string {
  const { agent, permissions } = input;
  return [
    `You are ${agent.name}.`,
    '',
    `# Mission`,
    agent.mission,
    '',
    `# Role`,
    agent.body,
    '',
    `# Permissions`,
    `- mode: ${permissions.mode}`,
    `- can_create_issues: ${permissions.canCreateIssues}`,
    `- can_open_prs: ${permissions.canOpenPRs}`,
    `- can_merge_prs: ${permissions.canMergePRs}`,
    '',
    `# Loaded skills`,
    ...input.skills.map((s) => `- ${s.name}`),
  ].join('\n');
}

function renderUserMessage(input: CompileInput): string {
  const { task, repo } = input;
  const planBlock = renderAssignedPlanBlock(task);
  return [
    `# Task: ${task.ref}`,
    `Kind: ${task.kind}`,
    task.githubNumber ? `GitHub: #${task.githubNumber}` : '',
    '',
    '# Context',
    task.context,
    '',
    planBlock,
    '# Repository',
    `Full name: ${repo.fullName}`,
    `Default branch: ${repo.defaultBranch}`,
    `Worktree: ${repo.worktreePath}`,
    `Languages: ${repo.languages.join(', ') || '(unknown)'}`,
    `Toolchain: ${repo.toolchain.join(', ') || '(unknown)'}`,
    '',
    '# README excerpt',
    repo.readmeExcerpt || '(no README detected)',
    '',
    '# QA Playbook',
    repo.qaPlaybookSummary || '(no qa/ directory)',
    '',
    '# Files changed since last successful run for this agent',
    repo.changedFilesSinceLastRun.length === 0
      ? '(first run, or no changes since last run)'
      : repo.changedFilesSinceLastRun.map((f) => `- ${f}`).join('\n'),
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function renderAssignedPlanBlock(task: import('./types').TaskPayload): string {
  if (!task.assignedPlan) return '';
  return [
    '# Assigned test plan',
    `Plan: ${task.assignedPlan.name} (id: ${task.assignedPlan.id})`,
    '',
    'Execute every test case below. For each case that fails, emit a finding',
    'whose `case_id` field matches the id from the plan so the user can map',
    'findings back to specific cases.',
    '',
    task.assignedPlan.body,
    '',
  ].join('\n');
}

function renderClaudeSettings(input: CompileInput): string {
  // The shape mirrors what the `claude` CLI consumes for tool gating.
  // `defaultModel` is set when (a) the caller passed a per-run modelOverride
  // (Test Plans popover) OR (b) the user configured a Claude model in
  // Settings. Hardcoding a name like `claude-sonnet-4-6` rots fast as new
  // model versions ship, and pinning a model the user's account doesn't
  // license breaks the CLI invocation. Empty everywhere → claude picks.
  const claudeModel = resolveRunnerModel('claude', input.modelOverride);
  const settings: Record<string, unknown> = {
    permissions: {
      allowedTools: ['fs.read', 'fs.write', 'shell.run', 'git.commit'],
      deny:
        input.permissions.mode === 'observe'
          ? ['git.push', 'github.create_issue', 'github.create_pr', 'github.merge']
          : input.permissions.mode === 'issues'
            ? ['github.create_pr', 'github.merge']
            : input.permissions.mode === 'prs'
              ? ['github.merge']
              : [],
    },
  };
  if (claudeModel) settings['defaultModel'] = claudeModel;
  return JSON.stringify(settings, null, 2);
}

function renderRunnerArgs(_input: CompileInput): string[] {
  // `-p` runs claude non-interactively; the user message is piped on stdin.
  //
  // `--output-format stream-json --include-partial-messages` gives us live
  // text deltas instead of the default text-mode behaviour, which buffers
  // the entire assistant turn before printing. Without this, CASE_* markers
  // never reach Mission Control's Plan tab until the whole run completes —
  // the user reported "all 45 cases stuck in Queued" because of that.
  // The runner (`src/main/runners/claude-code.ts`) parses the JSONL events
  // back into plain text before handing them to CaseProgressTracker and
  // BEGIN_FINDINGS parsing. `--verbose` is required by the CLI when
  // stream-json output is used with `-p`.
  return [
    '-p',
    '--system-prompt-file',
    '.claude/SYSTEM.md',
    '--settings',
    '.claude/settings.json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
}
