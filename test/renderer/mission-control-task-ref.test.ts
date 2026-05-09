import { describe, expect, it } from 'vitest';
import { parsePlanIdFromTaskRef } from '../../src/renderer/screens/MissionControl';

describe('parsePlanIdFromTaskRef', () => {
  it('extracts the plan id from QA Hunter / Manual QA refs', () => {
    expect(parsePlanIdFromTaskRef('plan:full-app')).toBe('full-app');
    expect(parsePlanIdFromTaskRef('plan:feature-auth')).toBe('feature-auth');
  });

  it('extracts the plan id from iOS QA Pilot refs (the regression that hid the plan tab)', () => {
    expect(parsePlanIdFromTaskRef('ios-qa:abc123:01KR4DSD4MF5:plan:full-app')).toBe('full-app');
    expect(parsePlanIdFromTaskRef('ios-qa:flow-1:run-2:plan:feature-onboarding')).toBe(
      'feature-onboarding',
    );
  });

  it('returns null for refs that have no plan segment', () => {
    expect(parsePlanIdFromTaskRef(null)).toBeNull();
    expect(parsePlanIdFromTaskRef('')).toBeNull();
    expect(parsePlanIdFromTaskRef('gh:42')).toBeNull();
    expect(parsePlanIdFromTaskRef('backlog:item-9')).toBeNull();
    // Old iOS task ref shape (no plan segment) — backward compat: null is fine.
    expect(parsePlanIdFromTaskRef('ios-qa:abc:01KR4')).toBeNull();
  });
});
