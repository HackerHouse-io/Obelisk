import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
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
        env: runnerEnv(),
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
      const stderr = result.stderr.trim();
      const stdoutTail = result.stdout.trim().split('\n').slice(-3).join(' | ').slice(-300);
      // Claude reports auth state on stdout (e.g. "Not logged in · Please run /login").
      // Classify those as auth_required so the orchestrator can pause the
      // agent and surface a sign-in CTA instead of a generic INTERNAL.
      if (looksLikeAuthRequired(result.stdout, stderr)) {
        return {
          ok: false,
          reason: 'auth_required',
          detail: stdoutTail || stderr.slice(-300) || 'claude reports it is not signed in',
        };
      }
      const detail = stderr
        ? `claude exited ${result.exitCode ?? '?'}; stderr: ${stderr.slice(-500)}`
        : stdoutTail
          ? `claude exited ${result.exitCode ?? '?'} with no stderr; last stdout: ${stdoutTail}`
          : `claude exited ${result.exitCode ?? '?'} with no output. Verify 'claude' is installed and authenticated (run 'claude --version' in a terminal).`;
      return { ok: false, reason: 'non_zero_exit', detail };
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
    return {
      ok: false,
      reason: 'no_changes',
      detail: 'worktree had no staged changes after run',
      // Read-only agents emit findings on stdout; preserve them so the
      // orchestrator's no_changes-coerce-to-ok path can parse BEGIN_FINDINGS.
      reasoning,
    };
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
