import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnAgentCli, checkInstalled } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
import { ClaudeStreamParser } from './claude-stream-json';
import { recordObserved } from './observed-models';
import { collectPatch } from './collect-patch';
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
      onEvent: (event) => {
        opts.onAudit({ at: new Date().toISOString(), kind: 'agent_event', payload: event });
        // Harvest the concrete model the CLI resolved (e.g. `claude-opus-4-8`)
        // so model dropdowns can label the always-latest alias rows with the
        // real version — for free, from every real run. See model-discovery.ts.
        if (event.type === 'session_init' && event.model) {
          recordObserved(event.model, new Date().toISOString());
        }
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
      // Salvage: the CLI sometimes exits non-zero AFTER emitting a successful
      // `result` envelope (post-run teardown / MCP shutdown noise). If the run
      // actually completed and did real work, honour it as success rather than
      // discarding a full sweep's findings over a stray exit code.
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
        ? `claude exited ${result.exitCode ?? '?'}; stderr: ${stderr.slice(-500)}`
        : stdoutTail
          ? `claude exited ${result.exitCode ?? '?'} with no stderr; last stdout: ${stdoutTail}`
          : `claude exited ${result.exitCode ?? '?'} with no output. Verify 'claude' is installed and authenticated (run 'claude --version' in a terminal).`;
      return { ok: false, reason: 'non_zero_exit', detail, reasoning: parser.reasoning() };
    }

    // Success path: hand the parsed assistant text to collectPatch as
    // reasoning. BEGIN_FINDINGS / suggested_test / etc. live in this text;
    // raw JSONL would defeat the parser.
    return collectPatch(opts, parser.reasoning());
  }
}
