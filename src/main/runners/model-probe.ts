import { tmpdir } from 'node:os';
import { spawnAgentCli } from './spawn';
import { runnerEnv } from './env';
import { ClaudeStreamParser } from './claude-stream-json';
import type { ClaudeFamily } from './observed-models';

/**
 * Cheap, no-API-key model probe.
 *
 * `claude --model <alias> --output-format stream-json --verbose` emits a
 * `system:init` event as its *first* stdout line — it carries the concrete
 * model the CLI resolved (e.g. `claude-opus-4-8`) and is printed *before* any
 * inference runs (`num_turns:0`, `total_cost_usd:0`). We spawn, read that one
 * line, then abort the process. No tokens are spent and no API key is touched;
 * the CLI's own startup handshake is the source of truth.
 *
 * Returns the resolved id, or null on any failure (CLI missing, not signed in,
 * timeout) — callers must treat null as "unknown" and fall back gracefully.
 */
export async function probeResolvedModel(
  alias: ClaudeFamily,
  timeoutMs = 15000,
): Promise<string | null> {
  const controller = new AbortController();
  let resolvedModel: string | null = null;

  const parser = new ClaudeStreamParser({
    onText: () => undefined,
    onEvent: (event) => {
      if (event.type === 'session_init' && event.model) {
        resolvedModel = event.model;
        // We have what we came for — kill the process before it spends tokens.
        controller.abort();
      }
    },
  });

  try {
    await spawnAgentCli({
      command: 'claude',
      args: ['--model', alias, '-p', 'ok', '--output-format', 'stream-json', '--verbose'],
      cwd: tmpdir(),
      env: runnerEnv(),
      timeoutMs,
      onAudit: (line) => {
        if (line.kind === 'stdout' && typeof line.payload === 'string') {
          parser.feedLine(line.payload);
        }
      },
      abort: controller.signal,
    });
  } catch {
    // spawn error (claude not on PATH, etc.) — unknown.
    return resolvedModel;
  }

  return resolvedModel;
}
