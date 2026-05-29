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
    renderCaseContract(),
    '',
    task.assignedPlan.body,
    '',
  ].join('\n');
}

/**
 * The CASE_* contract — repeated verbatim in the Claude and Codex prompts.
 *
 * The previous version told the agent to "use the exact `case_id` from the
 * plan" while the ids lived in HTML comments — codex couldn't see them and
 * hallucinated fresh ULIDs, so every marker landed as orphan and 32/32
 * cases ended up Skipped. The slot ids (`C1`, `C2`, …) are visible in the
 * case headings and the orchestrator's parser accepts either form, so an
 * agent that quotes the slot still resolves cleanly.
 */
export function renderCaseContract(): string {
  return [
    '## Case execution contract',
    '',
    'Every case below has a slot id like `C1`, `C2`, … shown in its `### C# (id: …)` header.',
    '',
    'You MUST do all of the following:',
    '',
    '1. Before starting a case, print exactly one line: `CASE_START C#`',
    '2. After finishing a case, print exactly one line:',
    '   - `CASE_PASS C#`             — case behaves as expected',
    '   - `CASE_FAIL C#`             — case is broken; you ALSO emit a Finding (see below)',
    '   - `CASE_INCONCLUSIVE C# (reason)` — last resort; only if you genuinely cannot determine pass/fail after a real attempt',
    '3. Use the **slot id** from the header (`C1`, `C2`, …) in every CASE_* marker. Do not invent ids. Do not skip cases.',
    "4. For every `CASE_FAIL` you MUST emit a corresponding entry in the `BEGIN_FINDINGS` block with `case_id` set to the case's FULL ULID (the long id after `id:` in the same header).",
    '5. Markers must be on their own line, plain text, not inside a code fence.',
  ].join('\n');
}

/**
 * Tool rules denied for every run regardless of mode. The agent must NEVER
 * push or open/merge PRs itself — the harness (publisher) is the only thing
 * that pushes the branch and opens the PR (see agents/bug-fixer.md). Phrased
 * as `Bash(<cmd>:*)` rules because the agent reaches git/gh through Bash.
 */
const ALWAYS_DENY = [
  'Bash(git push:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh merge:*)',
];

function denyForMode(mode: CompileInput['permissions']['mode']): string[] {
  switch (mode) {
    case 'observe':
      // Read/triage only — no GitHub mutations at all.
      return [...ALWAYS_DENY, 'Bash(gh issue create:*)', 'Bash(gh issue edit:*)'];
    case 'issues':
      // May file issues, but not open/merge PRs.
      return [...ALWAYS_DENY];
    case 'prs':
    case 'automerge':
      // May open PRs (the harness does it); never self-merge.
      return [...ALWAYS_DENY];
  }
}

function renderClaudeSettings(input: CompileInput): string {
  // Claude Code's real settings.json schema: `permissions.{defaultMode,allow,
  // deny}` with tool NAMES (`Read`, `Edit`, `Bash`, `Bash(git push:*)`), NOT a
  // bespoke `allowedTools: ['fs.write', …]`. The old shape used an unrecognized
  // key with invented names, so the CLI silently ignored it: in headless `-p`
  // mode that left `Edit`/`Write` un-allowed (auto-denied with no human to
  // prompt) and turned the safety `deny` list into a no-op. `acceptEdits`
  // auto-approves file edits headlessly; `Bash` is allowed broadly so the agent
  // can run the repo's test suite, while `deny` (which takes precedence) keeps
  // push/PR/merge off-limits.
  //
  // `defaultModel` is set when (a) the caller passed a per-run modelOverride
  // (Test Plans popover) OR (b) the user configured a Claude model in
  // Settings. Hardcoding a name like `claude-sonnet-4-6` rots fast as new
  // model versions ship, and pinning a model the user's account doesn't
  // license breaks the CLI invocation. Empty everywhere → claude picks.
  const claudeModel = resolveRunnerModel('claude', input.modelOverride);
  const settings: Record<string, unknown> = {
    permissions: {
      defaultMode: 'acceptEdits',
      allow: [
        'Read',
        'Edit',
        'Write',
        'MultiEdit',
        'Grep',
        'Glob',
        'Bash',
        'WebFetch',
        'WebSearch',
      ],
      deny: denyForMode(input.permissions.mode),
    },
  };
  if (claudeModel) settings['defaultModel'] = claudeModel;
  return JSON.stringify(settings, null, 2);
}

function renderRunnerArgs(_input: CompileInput): string[] {
  // `-p` runs claude non-interactively; the user message is piped on stdin.
  //
  // `--permission-mode acceptEdits` is the robust, flag-level guarantee that
  // file edits auto-approve in headless mode — without it (and without a
  // permissive global ~/.claude on the host) the CLI would block every Edit/
  // Write, which is exactly why Bug Fixer ran read-only and produced no fix.
  // The `deny` rules in .claude/settings.json still gate push/PR/merge.
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
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
}
