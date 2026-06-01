import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
import { CodexStreamParser } from './codex-stream-json';
import { collectPatch } from './collect-patch';
import type { CodingAgentRunner, RunOpts, RunResult, AuditLine } from './types';

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

    // Codex is invoked with `--json` (set in codex-layout.ts), so each
    // stdout line is a JSON event, not raw text. Wrap onAudit so the rest
    // of the orchestrator (CaseProgressTracker, audit log, BEGIN_FINDINGS
    // parser) receives the parsed assistant text instead of a wall of
    // JSONL — and Mission Control's Activity tab gets the same structured
    // tool_call / tool_result rows the Claude Code runner produces.
    const parser = new CodexStreamParser({
      onText: (line) => {
        opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
      },
      onEvent: (event) => {
        opts.onAudit({ at: new Date().toISOString(), kind: 'agent_event', payload: event });
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
        command: 'codex',
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
      if (looksLikeAuthRequired(result.stdout, stderr)) {
        return {
          ok: false,
          reason: 'auth_required',
          detail: stdoutTail || stderr.slice(-300) || 'codex reports it is not signed in',
        };
      }
      // Salvage a completed turn that nonetheless exited non-zero (see the
      // claude-code runner for the rationale). Codex's early-exit failure
      // ("Reading prompt from stdin…") emits no turn.completed, so finalResult
      // stays null and this run correctly falls through to non_zero_exit.
      const fin = parser.finalResult();
      if (fin && fin.ok && (fin.turns > 0 || parser.reasoning().trim().length > 0)) {
        opts.onAudit({
          at: new Date().toISOString(),
          kind: 'state',
          payload: { salvagedNonzeroExit: true, exitCode: result.exitCode ?? null },
        });
        return collectPatch(opts, parser.reasoning());
      }
      const detail = stderr
        ? `codex exited ${result.exitCode ?? '?'}; stderr: ${stderr.slice(-500)}`
        : stdoutTail
          ? `codex exited ${result.exitCode ?? '?'} with no stderr; last stdout: ${stdoutTail}`
          : `codex exited ${result.exitCode ?? '?'} with no output. Verify 'codex' is installed and authenticated (run 'codex --version' in a terminal).`;
      return { ok: false, reason: 'non_zero_exit', detail, reasoning: parser.reasoning() };
    }

    // Success path: hand the parsed assistant text to collectPatch as
    // `reasoning`. With `--json` enabled, raw stdout is JSONL — feeding
    // that to BEGIN_FINDINGS / suggested_test parsers in the orchestrator
    // would defeat them. The parser's `reasoning()` is the joined
    // `agent_message` text only.
    return collectPatch(opts, parser.reasoning());
  }
}
