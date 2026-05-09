import { describe, it, expect } from 'vitest';
import {
  countByState,
  derivePerCaseState,
} from '../../src/renderer/screens/mission-control-helpers';
import type { AuditLine, PreviewedFinding, RunState, TestPlan } from '../../src/shared/types';

function makePlan(caseIds: string[]): TestPlan {
  return {
    frontmatter: {
      id: 'plan-1',
      title: 'Full app sweep',
      version: 1,
    },
    blocks: caseIds.map((id) => ({
      kind: 'case' as const,
      id,
      title: `Case ${id}`,
      expected: null,
      severity: null,
    })),
  } as unknown as TestPlan;
}

function progress(
  caseId: string,
  status: 'running' | 'passed' | 'failed' | 'inconclusive',
  at = '2026-05-08T00:00:00Z',
): AuditLine {
  return {
    id: `audit-${caseId}-${status}`,
    runId: 'run-1',
    at,
    kind: 'case_progress',
    payload: { caseId, status },
  } as unknown as AuditLine;
}

function counts(
  plan: TestPlan,
  auditLog: AuditLine[],
  runState: RunState,
  findings: PreviewedFinding[] = [],
) {
  return countByState(derivePerCaseState({ plan, auditLog, findings, runState }));
}

describe('derivePerCaseState', () => {
  it('during a live run, unmarked cases are queued', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'passed')];
    const c = counts(plan, log, 'running');
    expect(c).toEqual({ queued: 2, running: 0, passed: 1, failed: 0, inconclusive: 0, skipped: 0 });
  });

  it('during a live run, queued count drops as cases progress', () => {
    const plan = makePlan(['c1', 'c2', 'c3', 'c4']);
    const c0 = counts(plan, [], 'running');
    expect(c0.queued).toBe(4);
    const c1 = counts(plan, [progress('c1', 'running')], 'running');
    expect(c1.queued).toBe(3);
    expect(c1.running).toBe(1);
    const c2 = counts(
      plan,
      [progress('c1', 'running'), progress('c1', 'passed'), progress('c2', 'running')],
      'running',
    );
    expect(c2.queued).toBe(2);
    expect(c2.passed).toBe(1);
    expect(c2.running).toBe(1);
  });

  it('when the run is done with cases that never started, those cases are SKIPPED, not passed', () => {
    // Reproduces the production bug: 41 pass + 3 fail + 1 running + 45 queued
    // would jump to 86 pass at completion. Now the 45 unattempted cases are
    // surfaced as `skipped` instead of silently inflating the pass count.
    const allCases = Array.from({ length: 90 }, (_, i) => `c${i}`);
    const plan = makePlan(allCases);
    const log: AuditLine[] = [];
    for (let i = 0; i < 41; i++) log.push(progress(`c${i}`, 'passed'));
    for (let i = 41; i < 44; i++) log.push(progress(`c${i}`, 'failed'));
    log.push(progress('c44', 'running'));
    const c = counts(plan, log, 'done');
    expect(c.passed).toBe(41); // not 86 — unattempted cases are NOT passed
    expect(c.failed).toBe(3);
    expect(c.skipped).toBe(45); // the cases the agent never reached
    expect(c.inconclusive).toBe(1); // the lone CASE_START with no terminal
    expect(c.running).toBe(0); // a finished run never has live-running cases
    expect(c.queued).toBe(0); // queued only makes sense while the run is live
    expect(c.passed + c.failed + c.skipped + c.inconclusive + c.running + c.queued).toBe(90);
  });

  it('when the run is cancelled, unmarked cases are skipped', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'passed')];
    const c = counts(plan, log, 'cancelled');
    expect(c.passed).toBe(1);
    expect(c.skipped).toBe(2);
    expect(c.queued).toBe(0);
  });

  it('when the run failed, unmarked cases are skipped', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'failed')];
    const c = counts(plan, log, 'failed');
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(2);
    expect(c.queued).toBe(0);
  });

  it('a finding tagged with case_id flips that case to failed even without a CASE_FAIL marker', () => {
    const plan = makePlan(['c1', 'c2']);
    const findings = [
      {
        id: 'f1',
        runId: 'run-1',
        body: 'case_id: c2\nFooBar',
        dismissed: false,
      } as unknown as PreviewedFinding,
    ];
    const c = counts(plan, [progress('c1', 'passed')], 'done', findings);
    expect(c.passed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(0);
  });

  it('a case with CASE_START but no terminal marker is inconclusive once the run is done', () => {
    const plan = makePlan(['c1']);
    const c = counts(plan, [progress('c1', 'running')], 'done');
    expect(c.inconclusive).toBe(1);
    expect(c.running).toBe(0);
    expect(c.passed).toBe(0);
  });

  it('latest case_progress row wins for a given caseId', () => {
    const plan = makePlan(['c1']);
    const log = [
      progress('c1', 'running', '2026-05-08T00:00:00Z'),
      progress('c1', 'passed', '2026-05-08T00:00:01Z'),
    ];
    const c = counts(plan, log, 'running');
    expect(c.passed).toBe(1);
    expect(c.running).toBe(0);
  });
});
