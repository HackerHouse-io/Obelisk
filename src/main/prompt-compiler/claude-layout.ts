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
  return [
    `# Task: ${task.ref}`,
    `Kind: ${task.kind}`,
    task.githubNumber ? `GitHub: #${task.githubNumber}` : '',
    '',
    '# Context',
    task.context,
    '',
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

function renderClaudeSettings(input: CompileInput): string {
  // The shape mirrors what the `claude` CLI consumes for tool gating.
  // Phase 3 keeps this minimal; Phase 4+ wires real tool ACLs.
  return JSON.stringify(
    {
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
      defaultModel: 'claude-sonnet-4-6',
    },
    null,
    2,
  );
}

function renderRunnerArgs(_input: CompileInput): string[] {
  return ['-p', '--system-prompt-file', '.claude/SYSTEM.md', '--settings', '.claude/settings.json'];
}
