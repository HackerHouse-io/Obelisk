import { probeRunnerAuth } from '../runners/auth-probe';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import type { IpcMap } from '../../shared/types';

/**
 * IPC: probe a runner's sign-in state non-interactively. Used by the
 * "Verify sign-in" button on the auth banner so the user can confirm
 * they fixed an auth issue without launching a real run.
 */
export async function handleRunnerProbeAuth(
  payload: IpcMap['runner:probeAuth']['req'],
): Promise<IpcMap['runner:probeAuth']['res']> {
  return probeRunnerAuth(payload.runner);
}

/**
 * IPC: check whether each runner CLI is on PATH. The per-feature Generate
 * button uses this to disable itself up-front when the chosen runner is
 * missing, so we never spawn a generation job that's guaranteed to fail.
 */
export async function handleRunnersInstalled(
  _payload: IpcMap['runners:installed']['req'],
): Promise<IpcMap['runners:installed']['res']> {
  const [claude, codex] = await Promise.all([
    new ClaudeCodeRunner().isInstalled(),
    new CodexRunner().isInstalled(),
  ]);
  return {
    claude: {
      installed: claude.ok,
      ...(claude.version ? { version: claude.version } : {}),
      ...(claude.hint ? { hint: claude.hint } : {}),
    },
    codex: {
      installed: codex.ok,
      ...(codex.version ? { version: codex.version } : {}),
      ...(codex.hint ? { hint: codex.hint } : {}),
    },
  };
}
