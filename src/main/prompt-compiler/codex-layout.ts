import type { CompileInput, CompiledPrompt } from './types';

/**
 * Codex layout:
 *  - Skills inlined into userMessage as fenced sections under `## Skills`.
 *  - System prompt prepended to userMessage (Codex CLI doesn't take a
 *    separate system-prompt file).
 *  - Tool sandbox + reasoning effort encoded into runner args.
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
  return [
    `## Task: ${task.ref}`,
    `Kind: ${task.kind}`,
    task.githubNumber ? `GitHub: #${task.githubNumber}` : '',
    '',
    '## Context',
    task.context,
    '',
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
  // The exact reasoning effort + sandbox flags are version-dependent; we
  // pin a sensible default per agent and let runner-level overrides apply
  // in the runner module if needed.
  const reasoning =
    input.agent.name === 'feature-builder' || input.agent.name === 'bug-fixer' ? 'high' : 'medium';
  return [
    'exec',
    '--codex-model=gpt-5',
    `--codex-reasoning-effort=${reasoning}`,
    '--codex-sandbox=workspace-write',
    `--task-ref=${input.task.ref}`,
  ];
}
