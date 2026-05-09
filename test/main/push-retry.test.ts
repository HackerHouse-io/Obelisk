import { describe, expect, it } from 'vitest';
import { isPushRetryable } from '../../src/main/scheduler/auto-merge';

describe('isPushRetryable', () => {
  it('accepts the canonical --force-with-lease stale-info rejection', () => {
    expect(
      isPushRetryable(
        new Error(
          ' ! [rejected]        obelisk/abc -> obelisk/abc (stale info)\nerror: failed to push some refs',
        ),
      ),
    ).toBe(true);
  });

  it('accepts non-fast-forward + fetch-first rejections', () => {
    expect(isPushRetryable(new Error('error: failed to push (non-fast-forward)'))).toBe(true);
    expect(isPushRetryable(new Error('hint: fetch first'))).toBe(true);
    expect(isPushRetryable(new Error(' ! [rejected]        x -> x'))).toBe(true);
  });

  it('rejects auth / network errors so we don’t loop on broken setups', () => {
    expect(isPushRetryable(new Error('Permission denied (publickey)'))).toBe(false);
    expect(isPushRetryable(new Error('could not resolve host: github.com'))).toBe(false);
    expect(isPushRetryable(new Error('remote: HTTP 403'))).toBe(false);
  });

  it('rejects nullish / non-error values gracefully', () => {
    expect(isPushRetryable(null)).toBe(false);
    expect(isPushRetryable(undefined)).toBe(false);
    expect(isPushRetryable('')).toBe(false);
    expect(isPushRetryable({})).toBe(false);
  });
});
