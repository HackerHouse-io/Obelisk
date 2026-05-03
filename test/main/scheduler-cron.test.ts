import { describe, it, expect } from 'vitest';
import { defaultCronFor, isDue, nextFireAt } from '../../src/main/scheduler/cron';

describe('defaultCronFor', () => {
  it('returns the PRD §6.2 defaults', () => {
    expect(defaultCronFor('qa-hunter')).toBe('0 2 * * *');
    expect(defaultCronFor('manual-qa')).toBe('0 * * * *');
    expect(defaultCronFor('bug-fixer')).toBe('0 */2 * * *');
    expect(defaultCronFor('feature-builder')).toBe('0 */6 * * *');
    expect(defaultCronFor('pr-reviewer')).toBe('*/5 * * * *');
  });
});

describe('nextFireAt', () => {
  it('returns the next firing time strictly after the basis', () => {
    // Basis: 2026-05-03T01:00:00Z; cron `0 2 * * *` → 02:00 same day.
    const basis = new Date('2026-05-03T01:00:00Z');
    const next = nextFireAt('0 2 * * *', basis);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-03T02:00:00.000Z');
  });

  it('returns null on a malformed cron expression', () => {
    expect(nextFireAt('not a cron', new Date())).toBeNull();
  });

  it('hourly cron from a basis past the top of the hour rolls to the next hour', () => {
    const basis = new Date('2026-05-03T01:30:00Z');
    const next = nextFireAt('0 * * * *', basis);
    expect(next!.toISOString()).toBe('2026-05-03T02:00:00.000Z');
  });
});

describe('isDue', () => {
  const basis = new Date('2026-05-03T00:30:00Z');

  it('is due when the next fire time is at or before now', () => {
    // basis = 00:30; next 0 1 * * * = 01:00; now = 01:30 → due
    expect(isDue('0 1 * * *', basis, new Date('2026-05-03T01:30:00Z'))).toBe(true);
  });

  it('is not due when the next fire time is in the future', () => {
    // basis = 00:30; next 0 1 * * * = 01:00; now = 00:45 → not due
    expect(isDue('0 1 * * *', basis, new Date('2026-05-03T00:45:00Z'))).toBe(false);
  });

  it('a malformed cron is never due (returns false to skip the agent)', () => {
    expect(isDue('garbage', basis, new Date())).toBe(false);
  });
});
