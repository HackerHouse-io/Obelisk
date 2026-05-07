import { simpleGit } from 'simple-git';
import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
import type { CodingAgentRunner, RunOpts, RunResult } from './types';

export class CodexRunner implements CodingAgentRunner {
  readonly kind = 'codex' as const;

  isInstalled(): ReturnType<CodingAgentRunner['isInstalled']> {
    return checkInstalled('codex');
  }

  async run(opts: RunOpts, abort: AbortSignal): Promise<RunResult> {
    opts.onAudit({
      at: new Date().toISOString(),
      kind: 'state',
      payload: { stage: 'spawning', runner: 'codex' },
    });

    let result;
    try {
      result = await spawnAgentCli({
        command: 'codex',
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
      if (looksLikeAuthRequired(result.stdout, stderr)) {
        return {
          ok: false,
          reason: 'auth_required',
          detail: stdoutTail || stderr.slice(-300) || 'codex reports it is not signed in',
        };
      }
      const detail = stderr
        ? `codex exited ${result.exitCode ?? '?'}; stderr: ${stderr.slice(-500)}`
        : stdoutTail
          ? `codex exited ${result.exitCode ?? '?'} with no stderr; last stdout: ${stdoutTail}`
          : `codex exited ${result.exitCode ?? '?'} with no output. Verify 'codex' is installed and authenticated (run 'codex --version' in a terminal).`;
      return { ok: false, reason: 'non_zero_exit', detail };
    }

    return collectPatch(opts, result.stdout);
  }
}

async function collectPatch(opts: RunOpts, reasoning: string): Promise<RunResult> {
  const git = simpleGit(opts.worktreePath);
  await git.add('--all');
  const status = await git.status();
  if (status.files.length === 0) {
    return {
      ok: false,
      reason: 'no_changes',
      detail: 'worktree had no staged changes after run',
      // Read-only agents (qa-hunter, manual-qa, pr-reviewer) emit findings on
      // stdout. Carrying the reasoning through here keeps the orchestrator
      // from dropping it when it coerces no_changes → ok for those agents.
      reasoning,
    };
  }
  const diff = await git.diff(['--cached']);
  const filesChanged = [...new Set(status.files.map((f) => f.path))].sort();
  return {
    ok: true,
    patch: { diff, filesChanged },
    testsRun: [],
    reasoning,
  };
}
