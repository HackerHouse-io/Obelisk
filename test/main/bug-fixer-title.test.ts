import { describe, expect, it } from 'vitest';
import { buildPrTitle } from '../../src/main/agents/bug-fixer/index';

/**
 * Regression coverage for the runaway PR-title bug. The earlier
 * implementation used `oneLine(runResult.reasoning)` to derive the
 * title, but Claude Code's stream-of-consciousness output has no
 * early newlines, so `oneLine` returned an entire monologue. The fix
 * is to derive from the GitHub issue title (`task.context`).
 */
describe('buildPrTitle', () => {
  it('uses the issue title with a `fix:` prefix', () => {
    expect(buildPrTitle('Home capstone path node opens read-only', 'issue#42')).toBe(
      'fix: Home capstone path node opens read-only',
    );
  });

  it('strips a `[bug]` (or similar) bracketed prefix from the issue title', () => {
    expect(buildPrTitle('[bug] Home capstone path node opens read-only', 'issue#42')).toBe(
      'fix: Home capstone path node opens read-only',
    );
    expect(buildPrTitle('[BUG] Crash on cold start', 'issue#1')).toBe(
      'fix: Crash on cold start',
    );
    expect(buildPrTitle('[bug][P0] Crash on cold start', 'issue#1')).toBe(
      'fix: Crash on cold start',
    );
  });

  it('does NOT add a redundant `fix:` prefix when the issue title already begins with one', () => {
    expect(buildPrTitle('fix: legacy router crash', 'issue#1')).toBe(
      'fix: legacy router crash',
    );
    expect(buildPrTitle('Fix Login spinner stuck', 'issue#1')).toBe(
      'Fix Login spinner stuck',
    );
  });

  it('falls back to the task ref when the issue title is empty / undefined', () => {
    // The fallback already starts with `Fix`, so prefixWithFix is a no-op
    // (it would otherwise produce a redundant `fix: Fix …`).
    expect(buildPrTitle(undefined, 'issue#42')).toBe('Fix issue#42');
    expect(buildPrTitle('', 'backlog#01HXYZ')).toBe('Fix backlog#01HXYZ');
    expect(buildPrTitle('   ', 'issue#7')).toBe('Fix issue#7');
  });

  it('caps overly-long titles at the conventional-commit length (72 chars) with a word-aware ellipsis', () => {
    const long =
      'Now I have full understanding. Let me follow the Prove-It Pattern: extract a pure routing helper that initially mirrors the current buggy logic, write a failing test, commit, then fix';
    const out = buildPrTitle(long, 'issue#4');
    expect(out.startsWith('fix: ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(72);
    // Ends with the truncation marker, not mid-word.
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses embedded newlines (defensive — issue titles can have stray \\r\\n on copy-paste)', () => {
    expect(buildPrTitle('Line one\nLine two', 'issue#1')).toBe('fix: Line one Line two');
  });
});
