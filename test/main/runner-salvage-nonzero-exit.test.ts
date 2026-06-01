import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompiledPrompt } from '../../src/main/prompt-compiler';
import type { RunOpts } from '../../src/main/runners/types';

// Mock the CLI spawn + patch collection so the test is hermetic (no real
// `claude` binary, no git). We're exercising the runner's exit-code handling:
// a process that exits non-zero AFTER emitting a successful `result` envelope
// must be salvaged (its findings flow through collectPatch), not discarded.
vi.mock('../../src/main/runners/spawn', () => ({
  spawnAgentCli: vi.fn(),
  checkInstalled: vi.fn(async () => ({ ok: true, version: 'mock' })),
}));
vi.mock('../../src/main/runners/collect-patch', () => ({
  collectPatch: vi.fn(async (_opts: RunOpts, reasoning: string) => ({
    ok: true as const,
    patch: { diff: '', filesChanged: [] },
    testsRun: [],
    reasoning,
  })),
}));

import { spawnAgentCli } from '../../src/main/runners/spawn';
import { collectPatch } from '../../src/main/runners/collect-patch';
import { ClaudeCodeRunner } from '../../src/main/runners/claude-code';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-salvage-'));
  vi.mocked(collectPatch).mockClear();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function buildOpts(): RunOpts {
  return {
    worktreePath: tmp,
    timeoutMs: 30_000,
    onAudit: () => {},
    prompt: {
      systemPrompt: 'system',
      attachments: [],
      runnerArgs: ['-p'],
      userMessage: 'go',
    } as unknown as CompiledPrompt,
  };
}

/** Drive spawnAgentCli's mock: feed the given stdout lines through onAudit
 *  (as the real spawn does) so the runner's parser sees them, then resolve
 *  with a non-zero exit. */
function spawnReturns(lines: string[]): void {
  vi.mocked(spawnAgentCli).mockImplementation(
    async (opts: { onAudit: (l: { at: string; kind: string; payload: unknown }) => void }) => {
      for (const line of lines) {
        opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
      }
      return {
        exitCode: 1,
        stdout: lines.join('\n'),
        stderr: '',
        timedOut: false,
      } as Awaited<ReturnType<typeof spawnAgentCli>>;
    },
  );
}

describe('ClaudeCodeRunner — non-zero-exit salvage', () => {
  it('salvages a completed run that exited 1 (real work done → findings kept)', async () => {
    spawnReturns([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'BEGIN_FINDINGS\n[]\nEND_FINDINGS' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', num_turns: 7 }),
    ]);

    const result = await new ClaudeCodeRunner().run(buildOpts(), new AbortController().signal);

    // Salvaged: collectPatch was invoked with the reasoning rather than the
    // run being hard-failed as non_zero_exit.
    expect(vi.mocked(collectPatch)).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reasoning).toContain('BEGIN_FINDINGS');
  });

  it('does NOT salvage a degenerate empty run (0 turns, no output) → retried', async () => {
    spawnReturns([JSON.stringify({ type: 'result', subtype: 'success', num_turns: 0 })]);

    const result = await new ClaudeCodeRunner().run(buildOpts(), new AbortController().signal);

    expect(vi.mocked(collectPatch)).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('non_zero_exit');
  });
});
