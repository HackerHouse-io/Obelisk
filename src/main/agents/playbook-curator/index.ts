import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import type { Repo } from '../../../shared/types';
import { ObeliskError } from '../../../shared/errors';
import { createWorktree, destroyWorktree } from '../../git/worktree';
import { spawnAgentCli } from '../../runners/spawn';
import { runnerEnv } from '../../runners/env';
import { effectiveDefaultRunner } from '../../runners/effective-default';
import { walkMarkdownFiles } from '../../util/walk-markdown';
import { bootstrapPlaybook, type PlaybookFile } from '../playbook-bootstrapper';

/**
 * Deep playbook regeneration.
 *
 * Spawns the repo's default CLI runner in an isolated worktree pre-seeded
 * with the heuristic bootstrap output, asks it to rewrite each qa/*.md file
 * to be specific to this codebase, then collects the resulting files. The
 * caller decides whether to surface them as a draft or write them back to
 * the user's local clone.
 */
export interface DeepRegenOutput {
  files: PlaybookFile[];
  framework: string;
  runnerUsed: string;
}

const DEEP_TIMEOUT_MS = 8 * 60 * 1000;

const SYSTEM_PROMPT =
  'You are a QA Playbook curator. You read a repository and rewrite the files under qa/ so that they accurately describe THIS specific codebase. You only edit files inside qa/. You never delete files. You return no commentary; the only output that matters is the file edits in the worktree.';

export async function deepRegeneratePlaybook(repo: Repo): Promise<DeepRegenOutput> {
  const seed = bootstrapPlaybook({ repo });

  const runId = `playbook-${ulid().slice(-8).toLowerCase()}`;
  const wt = await createWorktree({
    repoPath: repo.localPath,
    repoId: repo.id,
    runId,
    baseBranch: repo.defaultBranch,
  });

  try {
    for (const f of seed.files) {
      const target = join(wt.worktreePath, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.contents, 'utf8');
    }

    const command = effectiveDefaultRunner(repo) === 'codex' ? 'codex' : 'claude';
    const args = command === 'codex' ? codexArgs() : claudeArgs();
    const stdin = curatorPrompt(repo, seed.framework);

    const abort = new AbortController();
    const result = await spawnAgentCli({
      command,
      args,
      cwd: wt.worktreePath,
      env: runnerEnv(),
      stdin,
      timeoutMs: DEEP_TIMEOUT_MS,
      onAudit: () => {
        // The orchestrator audit log isn't connected for this one-shot path;
        // CLI stdout/stderr is captured in SpawnResult and surfaced via the
        // caller's error message on failure.
      },
      abort: abort.signal,
    });

    if (result.timedOut) {
      throw new ObeliskError(
        'TIMEOUT',
        `Deep regenerate timed out after ${DEEP_TIMEOUT_MS / 1000 / 60} minutes`,
      );
    }
    if (result.exitCode !== 0) {
      throw new ObeliskError(
        'INTERNAL',
        `${command} exited ${result.exitCode ?? '?'}`,
        result.stderr.slice(-500) || 'no stderr captured',
      );
    }

    const files = collectQaFiles(wt.worktreePath);
    return { files, framework: seed.framework, runnerUsed: command };
  } finally {
    await destroyWorktree(repo.localPath, wt.worktreePath).catch(() => undefined);
  }
}

function claudeArgs(): string[] {
  return ['-p', '--system-prompt', SYSTEM_PROMPT];
}

function codexArgs(): string[] {
  return [
    'exec',
    '--model',
    'gpt-5',
    '--sandbox',
    'workspace-write',
    '-c',
    'model_reasoning_effort="high"',
  ];
}

function curatorPrompt(repo: Repo, framework: string): string {
  return [
    `# Task: rewrite the qa/ playbook for ${repo.githubFullName}`,
    '',
    `Detected framework heuristic: \`${framework}\`. The repo lives at the current working directory.`,
    '',
    '## What to do',
    '',
    '1. Read the repo enough to understand what the product is, the entry points, and the user flows.',
    '2. Rewrite each existing file under `qa/` to be accurate for THIS codebase. Replace placeholders with real content.',
    '   - `qa/product-map.md` — what this product is, real entry points, real top-level architecture.',
    '   - `qa/critical-flows.md` — the actual must-pass user flows for this product.',
    '   - `qa/expected-behavior.md` — concrete success criteria per flow.',
    '   - `qa/bug-rules.md` — keep universal rules; add product-specific bug patterns.',
    '   - `qa/non-bugs.md` — known false positives specific to this product.',
    '   - `qa/test-users.md` — real seed accounts if you find them in seed files.',
    '   - `qa/playwright/flows/*.flow.md` — real steps for each flow.',
    '3. Add new flow files under `qa/playwright/flows/` if you discover flows not yet listed.',
    '',
    '## Rules',
    '',
    '- Edit files only under `qa/`. Do not touch any other path.',
    '- Do not delete files; only rewrite or add.',
    '- Be specific. "Login flow" without steps is not useful — list the actual screens and the actual fields.',
    '- If you cannot determine something, mark it `_(unknown — please fill in)_` rather than inventing it.',
    '',
    'When you are done, exit. The diff in the worktree is the result.',
  ].join('\n');
}

function collectQaFiles(worktreePath: string): PlaybookFile[] {
  return walkMarkdownFiles(join(worktreePath, 'qa')).map((f) => ({
    path: join('qa', f.relPath),
    contents: f.contents,
  }));
}
