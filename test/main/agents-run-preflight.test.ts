import { describe, expect, it } from 'vitest';
import { assertModeAllowsAgent } from '../../src/main/ipc/agents';
import type { SafetyMode } from '../../src/shared/types';

const repoOf = (mode: SafetyMode) => ({ mode, githubFullName: 'acme/app' });
const patchAgent = { producesPatch: true };
const readOnlyAgent = { producesPatch: false };

/**
 * Regression coverage for the "16-minute Bug Fixer run dies at publish
 * with MODE_TOO_LOW" production failure. The pre-flight is a pure
 * predicate; we test it directly to avoid the full IPC + runAgent
 * spawn path.
 */
describe('assertModeAllowsAgent (pre-flight gate)', () => {
  it('rejects a producesPatch agent in observe mode', () => {
    expect(() =>
      assertModeAllowsAgent(repoOf('observe'), patchAgent, 'Bug Fixer'),
    ).toThrowError(
      expect.objectContaining({
        code: 'MODE_TOO_LOW',
        message: expect.stringMatching(/observe/),
        hint: expect.stringMatching(/Fix & build|safety mode/i),
      }),
    );
  });

  it('rejects a producesPatch agent in issues mode (no commit/push allowed)', () => {
    expect(() =>
      assertModeAllowsAgent(repoOf('issues'), patchAgent, 'Bug Fixer'),
    ).toThrowError(expect.objectContaining({ code: 'MODE_TOO_LOW' }));
  });

  it('allows a producesPatch agent in prs mode', () => {
    expect(() =>
      assertModeAllowsAgent(repoOf('prs'), patchAgent, 'Bug Fixer'),
    ).not.toThrow();
  });

  it('allows a producesPatch agent in automerge mode', () => {
    expect(() =>
      assertModeAllowsAgent(repoOf('automerge'), patchAgent, 'Bug Fixer'),
    ).not.toThrow();
  });

  it('allows a read-only agent in any mode (qa-hunter, manual-qa, pr-reviewer)', () => {
    for (const mode of ['observe', 'issues', 'prs', 'automerge'] as SafetyMode[]) {
      expect(() => assertModeAllowsAgent(repoOf(mode), readOnlyAgent, 'QA Hunter')).not.toThrow();
    }
  });

  it("uses the agent's display name in the error message so users see which one is gated", () => {
    expect(() =>
      assertModeAllowsAgent(repoOf('observe'), patchAgent, 'Bug Fixer 2'),
    ).toThrowError(/Bug Fixer 2/);
  });
});
