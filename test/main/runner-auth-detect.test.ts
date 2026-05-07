import { describe, expect, it } from 'vitest';
import { looksLikeAuthRequired } from '../../src/main/runners/detect-auth';

describe('looksLikeAuthRequired', () => {
  it('matches the real Claude string we observed: "Not logged in · Please run /login"', () => {
    expect(looksLikeAuthRequired('Not logged in · Please run /login', '')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(looksLikeAuthRequired('NOT LOGGED IN', '')).toBe(true);
    expect(looksLikeAuthRequired('not logged in', '')).toBe(true);
  });

  it('matches Codex-flavored "Please sign in" / "run codex login"', () => {
    expect(looksLikeAuthRequired('Please sign in to continue.', '')).toBe(true);
    expect(looksLikeAuthRequired('You are not authenticated. Run codex login.', '')).toBe(true);
    expect(looksLikeAuthRequired('', 'Run `codex login` to continue.')).toBe(true);
  });

  it('matches "you are not signed in" variants', () => {
    expect(looksLikeAuthRequired('You are not signed-in to this account.', '')).toBe(true);
    expect(looksLikeAuthRequired('You are not signed in.', '')).toBe(true);
  });

  it('matches token / 401 hints', () => {
    expect(looksLikeAuthRequired('', 'token expired')).toBe(true);
    expect(looksLikeAuthRequired('', '401 Unauthorized')).toBe(true);
    expect(looksLikeAuthRequired('', '401 unauthorised')).toBe(true);
  });

  it('handles either stdout or stderr alone', () => {
    expect(looksLikeAuthRequired('Not logged in', '')).toBe(true);
    expect(looksLikeAuthRequired('', 'Authentication required')).toBe(true);
  });

  it('does NOT match generic non-zero exit messages', () => {
    expect(
      looksLikeAuthRequired(
        'Error: failed to read /etc/hosts',
        'TypeError: Cannot read properties of undefined',
      ),
    ).toBe(false);
    expect(looksLikeAuthRequired('Plan executed; no findings.', '')).toBe(false);
  });

  it('does NOT match the substring "login" without the broader pattern', () => {
    // "login.tsx" path mention shouldn't trip the detector.
    expect(looksLikeAuthRequired('Touched src/login.tsx', '')).toBe(false);
  });
});
