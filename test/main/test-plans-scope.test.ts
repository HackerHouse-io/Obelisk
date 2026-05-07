import { describe, expect, it } from 'vitest';
import { parsePlanFile, serializePlan } from '../../src/main/test-plans/parse';
import type { TestPlanBlock, TestPlanFrontmatter } from '../../src/shared/types';

const FRONTMATTER: TestPlanFrontmatter = {
  id: 'full-app',
  name: 'Full app sweep',
  scope: 'whole-app',
  feature: null,
  agentName: 'qa-hunter',
  generatedAt: '2026-05-07T12:00:00Z',
  generatedBy: 'manual',
  version: 1,
};

describe('test-plan markdown scope round-trip', () => {
  it('serializes scope as `scope:label1,label2` after the severity tag', () => {
    const blocks: TestPlanBlock[] = [
      {
        kind: 'case',
        id: 'c1',
        title: 'Login works',
        expected: 'User reaches /home',
        repro: 'Submit valid creds',
        severity: 'P0',
        scope: ['auth', 'session'],
      },
    ];
    const md = serializePlan(FRONTMATTER, blocks);
    expect(md).toContain('- [ ] Login works severity:P0 scope:auth,session');
  });

  it('parses both severity and scope tags from a serialized line', () => {
    const md = serializePlan(FRONTMATTER, [
      {
        kind: 'case',
        id: 'c1',
        title: 'Checkout submits',
        expected: 'POST /charge returns 200',
        repro: 'Click pay',
        severity: 'P1',
        scope: ['checkout', 'billing'],
      },
    ]);
    const parsed = parsePlanFile(md);
    const c = parsed.blocks.find((b) => b.kind === 'case')!;
    if (c.kind !== 'case') throw new Error('expected case');
    expect(c.severity).toBe('P1');
    expect(c.scope).toEqual(['checkout', 'billing']);
    expect(c.title).toBe('Checkout submits');
  });

  it('parses lines without scope as scope: null', () => {
    const md = serializePlan(FRONTMATTER, [
      {
        kind: 'case',
        id: 'c1',
        title: 'A case with no scope',
        expected: null,
        repro: null,
        severity: 'P2',
        scope: null,
      },
    ]);
    const parsed = parsePlanFile(md);
    const c = parsed.blocks.find((b) => b.kind === 'case')!;
    if (c.kind !== 'case') throw new Error('expected case');
    expect(c.scope).toBeNull();
  });

  it('handles legacy plan files (severity but no scope tag) without losing severity', () => {
    const legacy = `---\nid: legacy\nname: Legacy plan\nscope: whole-app\nfeature: null\nagentName: qa-hunter\ngeneratedAt: 2026-01-01T00:00:00Z\ngeneratedBy: heuristic\nversion: 1\n---\n\n## Smoke\n\n- [ ] Boots without errors severity:P0\n  - **Expected:** Renders home\n`;
    const parsed = parsePlanFile(legacy);
    const c = parsed.blocks.find((b) => b.kind === 'case');
    if (!c || c.kind !== 'case') throw new Error('expected case');
    expect(c.severity).toBe('P0');
    expect(c.scope).toBeNull();
    expect(c.title).toBe('Boots without errors');
    expect(c.expected).toBe('Renders home');
  });

  it('round-trip is identity for the case data', () => {
    const original: TestPlanBlock[] = [
      { kind: 'section', id: 's1', title: 'Smoke' },
      {
        kind: 'case',
        id: 'c1',
        title: 'A',
        expected: 'B',
        repro: 'C',
        severity: 'P0',
        scope: ['smoke'],
      },
      { kind: 'section', id: 's2', title: 'Auth' },
      {
        kind: 'case',
        id: 'c2',
        title: 'Sign in',
        expected: null,
        repro: null,
        severity: null,
        scope: ['auth', 'session'],
      },
    ];
    const md = serializePlan(FRONTMATTER, original);
    const reparsed = parsePlanFile(md);
    // ids regenerate on parse — compare structurally.
    const stripIds = (b: TestPlanBlock): unknown => {
      if (b.kind === 'section') return { kind: 'section', title: b.title };
      return {
        kind: 'case',
        title: b.title,
        expected: b.expected,
        repro: b.repro,
        severity: b.severity,
        scope: b.scope,
      };
    };
    expect(reparsed.blocks.map(stripIds)).toEqual(original.map(stripIds));
  });
});
