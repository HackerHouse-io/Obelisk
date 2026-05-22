import { describe, it, expect } from 'vitest';
import {
  synthesizeMissingFindings,
  type CaseFinalState,
} from '../../src/main/orchestrator/qa-synthesis';
import type { AssignedPlan } from '../../src/main/prompt-compiler/types';
import type { PublishPlan } from '../../src/main/agents/types';

function buildPlan(): AssignedPlan {
  return {
    id: 'feature-x',
    name: 'Feature X sweep',
    body: '(rendered body)',
    caseRefs: [
      {
        sectionTitle: 'Smoke',
        caseId: '01KS6FS17CAZAAGGZGX0BMX9B0',
        slotId: 'C1',
        caseTitle: 'Login works',
        expected: 'user lands on /home',
        repro: '1. sign in',
        severity: 'P1',
      },
      {
        sectionTitle: 'Smoke',
        caseId: '01KS6FS17CDTJA6T9048X0FB69',
        slotId: 'C2',
        caseTitle: 'Logout works',
        expected: null,
        repro: null,
        severity: null,
      },
      {
        sectionTitle: 'Smoke',
        caseId: '01KS6FS17CZM3KNJ1QBDARDZ15',
        slotId: 'C3',
        caseTitle: 'Password reset works',
        expected: 'email sent',
        repro: null,
        severity: 'P2',
      },
    ],
  };
}

describe('synthesizeMissingFindings', () => {
  it('emits a synthetic finding for a failed case with no agent-provided finding', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      ['01KS6FS17CAZAAGGZGX0BMX9B0', { status: 'failed' }],
    ]);

    const out = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
    });

    expect(out).toHaveLength(1);
    const p = out[0];
    if (!p || p.kind !== 'issue') throw new Error('expected an issue plan');
    expect(p.finding?.synthetic).toBe(true);
    expect(p.finding?.case_id).toBe('01KS6FS17CAZAAGGZGX0BMX9B0');
    expect(p.title.toLowerCase()).toContain('login works');
    expect(p.body).toContain('obelisk:case_id=01KS6FS17CAZAAGGZGX0BMX9B0');
  });

  it('emits a "Could not verify" finding for an inconclusive case', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      [
        '01KS6FS17CZM3KNJ1QBDARDZ15',
        { status: 'inconclusive', detail: 'fixture missing' },
      ],
    ]);

    const out = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
    });

    expect(out).toHaveLength(1);
    const p = out[0];
    if (!p || p.kind !== 'issue') throw new Error('expected an issue plan');
    expect(p.title.toLowerCase()).toContain('could not verify');
    expect(p.finding?.actual.toLowerCase()).toContain('fixture missing');
    expect(p.finding?.severity).toBe('P2'); // inherits the case's severity
  });

  it('skips cases that already have an agent-provided finding', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      ['01KS6FS17CAZAAGGZGX0BMX9B0', { status: 'failed' }],
    ]);
    const existingPlans: PublishPlan[] = [
      {
        kind: 'issue',
        title: '[bug] Real agent-provided finding',
        body: 'body\n<!-- obelisk:case_id=01KS6FS17CAZAAGGZGX0BMX9B0 -->',
        labels: ['obelisk:fix', 'P1'],
        finding: {
          title: 'Real agent-provided finding',
          severity: 'P1',
          description: 'd',
          expected: 'e',
          actual: 'a',
          repro: 'r',
          suspected_files: [],
          suggested_test: 't',
          case_id: '01KS6FS17CAZAAGGZGX0BMX9B0',
        },
      },
    ];

    const out = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans,
    });
    expect(out).toEqual([]);
  });

  it('skips passed/skipped/running cases', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      ['01KS6FS17CAZAAGGZGX0BMX9B0', { status: 'passed' }],
      ['01KS6FS17CDTJA6T9048X0FB69', { status: 'skipped' }],
      ['01KS6FS17CZM3KNJ1QBDARDZ15', { status: 'running' }],
    ]);

    const out = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
    });
    expect(out).toEqual([]);
  });

  it('respects the known-fingerprints set so duplicate runs do not re-emit', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      ['01KS6FS17CAZAAGGZGX0BMX9B0', { status: 'failed' }],
    ]);

    const firstRun = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
    });
    expect(firstRun).toHaveLength(1);
    const fp = firstRun[0]!.kind === 'issue' ? firstRun[0]!.fingerprint : undefined;
    expect(typeof fp).toBe('string');

    const secondRun = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
      knownFingerprints: new Set([fp!]),
    });
    expect(secondRun).toEqual([]);
  });

  it('emits one finding per gap when multiple cases need synthesis', () => {
    const plan = buildPlan();
    const states = new Map<string, CaseFinalState>([
      ['01KS6FS17CAZAAGGZGX0BMX9B0', { status: 'failed' }],
      ['01KS6FS17CDTJA6T9048X0FB69', { status: 'failed' }],
      ['01KS6FS17CZM3KNJ1QBDARDZ15', { status: 'inconclusive', detail: 'unclear spec' }],
    ]);

    const out = synthesizeMissingFindings({
      plan,
      caseStates: states,
      existingPlans: [],
    });
    expect(out).toHaveLength(3);
    expect(
      out
        .filter((p): p is Extract<PublishPlan, { kind: 'issue' }> => p.kind === 'issue')
        .every((p) => p.finding?.synthetic === true),
    ).toBe(true);
  });
});
