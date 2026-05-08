/**
 * Non-interactive sign-in probe for each runner. The user clicks "Verify
 * sign-in" on the auth banner; we run a one-shot check against the locally-
 * installed CLI and report `ok / signed_out / failed`.
 *
 * Codex has a clean status command (`codex login status`) — zero API cost.
 * Claude has no equivalent, so we run `claude --print` with a minimal
 * prompt and a short timeout. That costs a sub-cent token roundtrip but
 * exercises the actual OAuth/keychain path the agent runner uses, which
 * is what we need to confirm.
 */
import { spawnAgentCli } from './spawn';
import { runnerEnv } from './env';
import { looksLikeAuthRequired } from './detect-auth';
import type { RunnerKind } from '../../shared/types';

export interface AuthProbeResult {
  runner: RunnerKind;
  status: 'signed_in' | 'signed_out' | 'cli_missing' | 'unknown';
  /** One-line human summary surfaced in the action card. */
  detail: string;
}

const PROBE_TIMEOUT_MS = 30_000;

export async function probeRunnerAuth(runner: RunnerKind): Promise<AuthProbeResult> {
  if (runner === 'codex') return probeCodex();
  return probeClaude();
}

async function probeCodex(): Promise<AuthProbeResult> {
  try {
    const result = await spawnAgentCli({
      command: 'codex',
      args: ['login', 'status'],
      cwd: process.cwd(),
      env: runnerEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
      onAudit: () => undefined,
      abort: new AbortController().signal,
    });
    if (result.timedOut) {
      return { runner: 'codex', status: 'unknown', detail: 'codex login status timed out.' };
    }
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode === 0 && /logged\s+in|signed\s+in|active\s+account/i.test(combined)) {
      return { runner: 'codex', status: 'signed_in', detail: lastNonEmpty(combined) };
    }
    if (looksLikeAuthRequired(result.stdout, result.stderr) || result.exitCode !== 0) {
      return {
        runner: 'codex',
        status: 'signed_out',
        detail: lastNonEmpty(combined) || `codex login status exited ${result.exitCode ?? '?'}`,
      };
    }
    return { runner: 'codex', status: 'unknown', detail: lastNonEmpty(combined) };
  } catch (e) {
    return {
      runner: 'codex',
      status: 'cli_missing',
      detail: `codex not on PATH (${(e as Error).message})`,
    };
  }
}

async function probeClaude(): Promise<AuthProbeResult> {
  try {
    const result = await spawnAgentCli({
      command: 'claude',
      args: ['--print', '--output-format', 'text', 'ok'],
      cwd: process.cwd(),
      env: runnerEnv(),
      stdin: '',
      timeoutMs: PROBE_TIMEOUT_MS,
      onAudit: () => undefined,
      abort: new AbortController().signal,
    });
    if (result.timedOut) {
      return { runner: 'claude', status: 'unknown', detail: 'claude --print timed out.' };
    }
    if (result.exitCode === 0) {
      return { runner: 'claude', status: 'signed_in', detail: 'claude --print succeeded.' };
    }
    if (looksLikeAuthRequired(result.stdout, result.stderr)) {
      return {
        runner: 'claude',
        status: 'signed_out',
        detail: lastNonEmpty(`${result.stdout}\n${result.stderr}`),
      };
    }
    return {
      runner: 'claude',
      status: 'unknown',
      detail:
        lastNonEmpty(`${result.stdout}\n${result.stderr}`) ||
        `claude --print exited ${result.exitCode ?? '?'}`,
    };
  } catch (e) {
    return {
      runner: 'claude',
      status: 'cli_missing',
      detail: `claude not on PATH (${(e as Error).message})`,
    };
  }
}

function lastNonEmpty(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : '';
}
