// auth/session.test.ts — written by Bug Fixer
import { describe, it, expect } from 'vitest';
import { getSameSite } from './session';

describe('getSameSite', () => {
  it('returns None for secure cookies on Safari', () => {
    expect(getSameSite(true)).toBe('None');
  });
});
