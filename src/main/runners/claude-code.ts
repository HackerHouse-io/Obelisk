import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
import { ClaudeStreamParser } from './claude-stream-json';
import type { CodingAgentRunner, RunOpts, RunResult, AuditLine } from './types';

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

    // Claude is invoked with `--output-format stream-json`, so each stdout
    // line is a JSON event, not raw text. Wrap onAudit so the rest of the
    // orchestrator (CaseProgressTracker, audit log, BEGIN_FINDINGS parser)
    // receives the natural assistant text instead of a wall of JSONL.
    const parser = new ClaudeStreamParser({
      onText: (line) => {
        opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
      },
      onMeta: (summary) => {
        // Single-line audit row so users can see the run is alive even
        // before the model has produced its first text delta.
        opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: summary });
      },
    });
    const wrappedOnAudit = (line: AuditLine): void => {
      if (line.kind !== 'stdout' || typeof line.payload !== 'string') {
        opts.onAudit(line);
        return;
      }
      parser.feedLine(line.payload);
    };

    let result;
    try {
      result = await spawnAgentCli({
        command: 'claude',
        args: opts.prompt.runnerArgs,
        cwd: opts.worktreePath,
        env: runnerEnv(),
        stdin: opts.prompt.userMessage,
        timeoutMs: opts.timeoutMs,
        onAudit: wrappedOnAudit,
        abort,
      });
    } catch (e) {
      return { ok: false, reason: 'crash', detail: (e as Error).message };
    }
    parser.flush();

    if (result.timedOut) {
      return { ok: false, reason: 'timeout', detail: `> ${opts.timeoutMs}ms` };
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdoutTail = result.stdout.trim().split('\n').slice(-3).join(' | ').slice(-300);
      // Auth failures fire BEFORE any model interaction, so the message
      // lands on stdout/stderr as plain text — not wrapped in JSON. Detection
      // still works against the raw spawn result.
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

    // Success path: hand the parsed assistant text to collectPatch as
    // reasoning. BEGIN_FINDINGS / suggested_test / etc. live in this text;
    // raw JSONL would defeat the parser.
    return collectPatch(opts, parser.reasoning());
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
