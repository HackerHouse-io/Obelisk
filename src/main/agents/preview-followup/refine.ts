import { ObeliskError } from '../../../shared/errors';
import { runnerEnv } from '../../runners/env';
import { spawnAgentCli } from '../../runners/spawn';
import { looksLikeAuthRequired } from '../../runners/detect-auth';
import { parseFencedJsonObject } from '../lib/parse-fenced-json';
import { buildOneShotClaudeArgs, buildOneShotCodexArgs } from '../lib/oneshot-cli-args';
import { isFinding } from '../qa-hunter';
import type { PreviewFollowup, QaFinding, RunnerKind } from '../../../shared/types';
import { BEGIN_FINDING, END_FINDING, buildRefinePrompt, extractAssistantReply } from './prompt';

const REFINE_TIMEOUT_MS = 60_000;

/**
 * One refine turn: feed the connected coding-agent CLI the current
 * finding + transcript + new user message, parse out the model's natural-
 * language reply and the updated structured finding. Read-only sandbox —
 * the CLI must not touch the workspace.
 *
 * Throws ObeliskError on infrastructure failures (CLI missing, sign-out,
 * timeout, non-zero exit, unparseable output). The IPC handler catches
 * those and converts them to typed Err results for the renderer.
 */
export async function refineFinding(opts: {
  runner: RunnerKind;
  cwd: string;
  current: QaFinding;
  transcript: PreviewFollowup[];
  userMessage: string;
  abort: AbortSignal;
}): Promise<{ assistantReply: string; updated: QaFinding }> {
  const command = opts.runner === 'codex' ? 'codex' : 'claude';
  const args = opts.runner === 'codex' ? buildOneShotCodexArgs() : buildOneShotClaudeArgs();
  const stdin = buildRefinePrompt({
    current: opts.current,
    transcript: opts.transcript,
    userMessage: opts.userMessage,
  });

  let result;
  try {
    result = await spawnAgentCli({
      command,
      args,
      cwd: opts.cwd,
      env: runnerEnv(),
      stdin,
      timeoutMs: REFINE_TIMEOUT_MS,
      onAudit: () => undefined,
      abort: opts.abort,
    });
  } catch (e) {
    throw new ObeliskError(
      'RUNNER_NOT_INSTALLED',
      `Failed to spawn ${command}: ${(e as Error).message}`,
      `Run \`${command} --version\` in a terminal to confirm the CLI is installed.`,
    );
  }

  if (result.timedOut) {
    throw new ObeliskError(
      'TIMEOUT',
      `${command} did not reply within ${Math.round(REFINE_TIMEOUT_MS / 1000)}s.`,
      'Try again, or open a fresh modal if the CLI is wedged.',
    );
  }
  if (result.exitCode !== 0) {
    if (looksLikeAuthRequired(result.stdout, result.stderr)) {
      throw new ObeliskError(
        'RUNNER_LOGIN_REQUIRED',
        `${command} reports it is not signed in.`,
        `Run \`${command} login\` and retry.`,
      );
    }
    const tail = result.stderr.trim().slice(-300) || result.stdout.trim().slice(-300);
    throw new ObeliskError(
      'INTERNAL',
      `${command} exited ${result.exitCode ?? '?'}${tail ? `: ${tail}` : ''}`,
    );
  }

  const updated = parseFencedJsonObject<QaFinding>(
    result.stdout,
    BEGIN_FINDING,
    END_FINDING,
    isFinding,
  );
  if (!updated) {
    throw new ObeliskError(
      'FINDINGS_NOT_PARSEABLE',
      'The model did not return a parseable updated finding.',
      'Try rephrasing your message — keep it short and direct.',
    );
  }
  const assistantReply = extractAssistantReply(result.stdout) || 'Updated.';
  return { assistantReply, updated };
}
