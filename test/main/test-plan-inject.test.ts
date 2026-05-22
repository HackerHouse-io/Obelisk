import { describe, it, expect } from 'vitest';
import { toAssignedPlan } from '../../src/main/test-plans/inject';
import type { TestPlan, TestPlanBlock } from '../../src/shared/types';

function plan(blocks: TestPlanBlock[]): TestPlan {
  return {
    frontmatter: {
      id: 'feature-x',
      name: 'Feature X sweep',
      scope: 'feature',
      feature: 'x',
      agentNames: ['qa-hunter'],
      generatedAt: '2026-05-21T20:00:00.000Z',
      generatedBy: 'manual',
      version: 1,
    },
    blocks,
    caseCount: blocks.filter((b) => b.kind === 'case').length,
    filePath: '/tmp/fake/qa/test-plans/feature-x.md',
    updatedAt: '2026-05-21T20:00:00.000Z',
  };
}

describe('toAssignedPlan', () => {
  it('assigns deterministic slot ids (C1, C2, …) in document order', () => {
    const assigned = toAssignedPlan(
      plan([
        { kind: 'section', id: 'sec-a', title: 'Smoke' },
        {
          kind: 'case',
          id: '01KS6FS17CAZAAGGZGX0BMX9B0',
          title: 'First',
          expected: 'works',
          repro: '1. open',
          severity: 'P1',
          scope: null,
        },
        {
          kind: 'case',
          id: '01KS6FS17CDTJA6T9048X0FB69',
          title: 'Second',
          expected: null,
          repro: null,
          severity: null,
          scope: null,
        },
        { kind: 'section', id: 'sec-b', title: 'Detail' },
        {
          kind: 'case',
          id: '01KS6FS17CZM3KNJ1QBDARDZ15',
          title: 'Third',
          expected: 'ok',
          repro: null,
          severity: 'P0',
          scope: null,
        },
      ]),
    );
    expect(assigned.caseRefs.map((c) => c.slotId)).toEqual(['C1', 'C2', 'C3']);
    expect(assigned.caseRefs[0]?.caseId).toBe('01KS6FS17CAZAAGGZGX0BMX9B0');
    expect(assigned.caseRefs[0]?.sectionTitle).toBe('Smoke');
    expect(assigned.caseRefs[2]?.sectionTitle).toBe('Detail');
  });

  it('renders the agent-facing body with visible slot + ULID in each header', () => {
    const assigned = toAssignedPlan(
      plan([
        { kind: 'section', id: 'sec-a', title: 'Smoke' },
        {
          kind: 'case',
          id: '01KS6FS17CAZAAGGZGX0BMX9B0',
          title: 'Login works',
          expected: 'user lands on /home',
          repro: '1. sign in',
          severity: 'P1',
          scope: null,
        },
      ]),
    );
    expect(assigned.body).toContain('## Smoke');
    expect(assigned.body).toContain('### C1 (id: 01KS6FS17CAZAAGGZGX0BMX9B0) — Login works');
    expect(assigned.body).toContain('[severity: P1]');
    expect(assigned.body).toContain('- **Expected:** user lands on /home');
    expect(assigned.body).toContain('- **Repro:** 1. sign in');
  });

  it('strips on-disk HTML comments — agent never sees `<!-- obelisk:id=… -->`', () => {
    const assigned = toAssignedPlan(
      plan([
        {
          kind: 'case',
          id: '01KS6FS17CAZAAGGZGX0BMX9B0',
          title: 'Some case',
          expected: null,
          repro: null,
          severity: null,
          scope: null,
        },
      ]),
    );
    expect(assigned.body).not.toMatch(/<!--\s*obelisk:id\s*=/);
  });

  it('mirrors expected/repro/severity into caseRefs so synthesis can read them', () => {
    const assigned = toAssignedPlan(
      plan([
        {
          kind: 'case',
          id: '01KS6FS17CAZAAGGZGX0BMX9B0',
          title: 'A',
          expected: 'works',
          repro: '1. do',
          severity: 'P0',
          scope: null,
        },
      ]),
    );
    expect(assigned.caseRefs[0]).toMatchObject({
      caseId: '01KS6FS17CAZAAGGZGX0BMX9B0',
      slotId: 'C1',
      expected: 'works',
      repro: '1. do',
      severity: 'P0',
    });
  });
});
