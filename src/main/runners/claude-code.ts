import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { spawnAgentCli, checkInstalled } from './spawn';
import type { CodingAgentRunner, RunOpts, RunResult } from './types';

export class ClaudeCodeRunner implements CodingAgentRunner {
  readonly kind = 'claude' as const;

  isInstalled(): ReturnType<CodingAgentRunner['isInstalled']> {
    return checkInstalled('claude');
  }

  async run(opts: RunOpts, abort: AbortSignal): Promise<RunResult> {
    // Materialize the system prompt + skill files into the worktree so the
    // `claude` CLI auto-loads them (TECH_DESIGN.md §7.3).
    const systemPromptPath = join(opts.worktreePath, '.claude', 'SYSTEM.md');
    mkdirSync(dirname(systemPromptPath), { recursive: true });
    writeFileSync(systemPromptPath, opts.prompt.systemPrompt, 'utf8');
    for (const att of opts.prompt.attachments) {
      const target = join(opts.worktreePath, att.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, att.contents, 'utf8');
    }

    opts.onAudit({
      at: new Date().toISOString(),
      kind: 'state',
      payload: { stage: 'spawning', runner: 'claude' },
    });

    let result;
    try {
      result = await spawnAgentCli({
        command: 'claude',
        args: opts.prompt.runnerArgs,
        cwd: opts.worktreePath,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          LANG: process.env['LANG'] ?? 'en_US.UTF-8',
          [opts.apiKeyEnv.name]: opts.apiKeyEnv.value,
        },
        stdin: opts.prompt.userMessage,
        timeoutMs: opts.timeoutMs,
        onAudit: opts.onAudit,
        abort,
      });
    } catch (e) {
      return { ok: false, reason: 'crash', detail: (e as Error).message };
    }

    if (result.timedOut) {
      return { ok: false, reason: 'timeout', detail: `> ${opts.timeoutMs}ms` };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: 'non_zero_exit',
        detail: `claude exited ${result.exitCode ?? '?'}; stderr: ${result.stderr.slice(-500)}`,
      };
    }

    return collectPatch(opts, result.stdout);
  }
}

/**
 * Walk the worktree's git status to materialize the patch + filesChanged.
 * Both runners produce side-effects in the worktree; the runner doesn't
 * need to parse patch markers out of stdout.
 */
async function collectPatch(opts: RunOpts, reasoning: string): Promise<RunResult> {
  const git = simpleGit(opts.worktreePath);
  await git.add('--all');
  const status = await git.status();
  if (status.files.length === 0) {
    return { ok: false, reason: 'no_changes', detail: 'worktree had no staged changes after run' };
  }
  const diff = await git.diff(['--cached']);
  const filesChanged = [...new Set(status.files.map((f) => f.path))].sort();
  return {
    ok: true,
    patch: { diff, filesChanged },
    testsRun: [], // Phase 4+ wires test extraction
    reasoning,
  };
}
