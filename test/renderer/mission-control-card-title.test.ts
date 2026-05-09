import { describe, expect, it } from 'vitest';
import { describeTaskRef } from '../../src/renderer/screens/MissionControl';

const NO_PLANS = new Map<string, string>();

/**
 * Mission Control's run-card title is the most-visible surface that tells a
 * user *which* GitHub issue (or plan, or manual backlog row) the agent
 * claimed. These tests pin the title/subtitle/href shape so a renderer
 * change can't silently regress that affordance.
 */
describe('describeTaskRef', () => {
  describe('GitHub issue (issue#N)', () => {
    it('uses the snapshotted task_context as the title', () => {
      const out = describeTaskRef('issue#42', 'Crash on cold start', NO_PLANS, 'acme/app');
      expect(out.title).toBe('Crash on cold start');
      expect(out.subtitle).toBe('GitHub issue #42');
    });

    it('falls back to "Issue #N" when no taskContext is stored', () => {
      const out = describeTaskRef('issue#7', null, NO_PLANS, 'acme/app');
      expect(out.title).toBe('Issue #7');
      expect(out.subtitle).toBe('GitHub issue #7');
    });

    it('builds a clickable github.com link when repoFullName is well-formed', () => {
      const out = describeTaskRef('issue#42', 'Crash', NO_PLANS, 'acme/app');
      expect(out.issueHref).toBe('https://github.com/acme/app/issues/42');
    });

    it('refuses to build a link when repoFullName is malformed (defends against URL injection)', () => {
      expect(describeTaskRef('issue#42', 'x', NO_PLANS, null).issueHref).toBeNull();
      expect(describeTaskRef('issue#42', 'x', NO_PLANS, 'no-slash').issueHref).toBeNull();
      expect(describeTaskRef('issue#42', 'x', NO_PLANS, 'a/b/c').issueHref).toBeNull();
      expect(describeTaskRef('issue#42', 'x', NO_PLANS, 'evil.com/path?x=y').issueHref).toBeNull();
    });
  });

  describe('Manual backlog (backlog#<id>)', () => {
    it('uses the manual title from task_context', () => {
      const out = describeTaskRef('backlog#01HXYZ', 'Polish onboarding', NO_PLANS, 'acme/app');
      expect(out.title).toBe('Polish onboarding');
      expect(out.subtitle).toBe('Manual backlog');
      expect(out.issueHref).toBeNull();
    });

    it('falls back gracefully when task_context is missing', () => {
      const out = describeTaskRef('backlog#01HXYZ', null, NO_PLANS, 'acme/app');
      expect(out.title).toBe('Manual backlog item');
    });
  });

  describe('Test plan (plan:<id>)', () => {
    it('resolves the plan id to its name when known', () => {
      const plans = new Map<string, string>([['feature-auth', 'Auth smoke']]);
      const out = describeTaskRef('plan:feature-auth', null, plans, null);
      expect(out.title).toBe('Auth smoke');
      expect(out.subtitle).toBe('Test plan');
    });

    it('marks deleted plans so the user knows the run will be empty', () => {
      const out = describeTaskRef('plan:gone', null, NO_PLANS, null);
      expect(out.subtitle).toBe('Test plan (deleted)');
    });
  });

  describe('Edge cases', () => {
    it('returns "Ad-hoc run" for null taskRef', () => {
      const out = describeTaskRef(null, null, NO_PLANS, null);
      expect(out.title).toBe('Ad-hoc run');
      expect(out.subtitle).toBeNull();
    });

    it('renders unknown refs verbatim so debugging surfaces them', () => {
      const out = describeTaskRef('weird-shape:abc', null, NO_PLANS, null);
      expect(out.title).toBe('weird-shape:abc');
      expect(out.subtitle).toBeNull();
    });
  });
});
