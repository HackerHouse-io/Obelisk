import { describe, it, expect } from 'vitest';
import { extractBlocks } from '../../src/main/test-plans/generate';

describe('extractBlocks (LLM output parser)', () => {
  it('parses BEGIN_TEST_PLAN / END_TEST_PLAN markers', () => {
    const stdout = `
Here is the plan you asked for.

BEGIN_TEST_PLAN
{
  "blocks": [
    { "kind": "section", "title": "Auth" },
    { "kind": "case", "title": "Sign up", "expected": "ok", "repro": "submit", "severity": "P0" }
  ]
}
END_TEST_PLAN

— done!
`;
    const blocks = extractBlocks(stdout);
    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]?.kind).toBe('section');
    expect(blocks?.[1]?.kind).toBe('case');
  });

  it('falls through to ```json fenced blocks when no markers', () => {
    const stdout =
      '```json\n{ "blocks": [{ "kind": "section", "title": "Smoke" }, { "kind": "case", "title": "Boots", "expected": "ok", "repro": "open", "severity": "P0" }] }\n```';
    const blocks = extractBlocks(stdout);
    expect(blocks?.[0]).toMatchObject({ kind: 'section', title: 'Smoke' });
  });

  it('falls through to a raw {...blocks: ...} object when neither marker nor fence', () => {
    const stdout =
      'Sure! Here it is: { "blocks": [{ "kind": "section", "title": "Checkout" }, { "kind": "case", "title": "Add to cart", "expected": "+1", "repro": "click", "severity": "P1" }] } that\'s the plan.';
    const blocks = extractBlocks(stdout);
    expect(blocks?.[0]).toMatchObject({ kind: 'section', title: 'Checkout' });
  });

  it('returns null on malformed JSON', () => {
    expect(extractBlocks('BEGIN_TEST_PLAN\n{ broken\nEND_TEST_PLAN')).toBeNull();
    expect(extractBlocks('total nonsense, no JSON anywhere')).toBeNull();
  });

  it('drops cases with bad shape but keeps the good ones', () => {
    const stdout = `BEGIN_TEST_PLAN
{
  "blocks": [
    { "kind": "section", "title": "Auth" },
    { "kind": "case", "title": "Good case", "expected": "ok", "repro": "do", "severity": "P0" },
    { "kind": "case" },
    { "kind": "section", "title": "Profile" }
  ]
}
END_TEST_PLAN`;
    const blocks = extractBlocks(stdout);
    expect(blocks).toHaveLength(3); // section + good case + section
    expect(blocks?.map((b) => b.kind)).toEqual(['section', 'case', 'section']);
  });
});
