import { simpleGit } from 'simple-git';
import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
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
      return {
        ok: false,
        reason: 'non_zero_exit',
        detail: `codex exited ${result.exitCode ?? '?'}; stderr: ${result.stderr.slice(-500)}`,
      };
    }

    return collectPatch(opts, result.stdout);
  }
}

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
    testsRun: [],
    reasoning,
  };
}
