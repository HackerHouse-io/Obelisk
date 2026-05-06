import { describe, it, expect } from 'vitest';
import { parsePlanFile, serializePlan, countCases } from '../../src/main/test-plans/parse';
import type { TestPlanFrontmatter } from '../../src/shared/types';

describe('test-plans parser', () => {
  it('round-trips frontmatter + sections + cases with sub-bullets', () => {
    const raw = `---
id: full-app
name: Full app sweep
scope: whole-app
feature: null
agentName: qa-hunter
generatedAt: 2026-05-05T20:00:00Z
generatedBy: claude
version: 1
---

## Authentication
- [ ] Sign up with valid email lands on onboarding severity:P0
  - **Expected:** redirected to /welcome with toast
  - **Repro:** open /signup, fill form, submit
- [ ] Sign in with wrong password shows inline error
  - **Expected:** error visible without page reload

## Checkout
- [ ] Add item to cart increments cart count
`;
    const parsed = parsePlanFile(raw);
    expect(parsed.frontmatter.id).toBe('full-app');
    expect(parsed.frontmatter.scope).toBe('whole-app');
    expect(parsed.frontmatter.agentName).toBe('qa-hunter');
    expect(parsed.blocks).toHaveLength(5); // 2 sections + 3 cases

    const auth = parsed.blocks[0]!;
    expect(auth.kind).toBe('section');
    if (auth.kind === 'section') expect(auth.title).toBe('Authentication');

    const firstCase = parsed.blocks[1]!;
    expect(firstCase.kind).toBe('case');
    if (firstCase.kind === 'case') {
      expect(firstCase.title).toBe('Sign up with valid email lands on onboarding');
      expect(firstCase.severity).toBe('P0');
      expect(firstCase.expected).toBe('redirected to /welcome with toast');
      expect(firstCase.repro).toBe('open /signup, fill form, submit');
    }

    expect(countCases(parsed.blocks)).toBe(3);

    const out = serializePlan(parsed.frontmatter, parsed.blocks);
    const reparsed = parsePlanFile(out);
    expect(reparsed.frontmatter.id).toBe(parsed.frontmatter.id);
    expect(reparsed.blocks).toHaveLength(parsed.blocks.length);
  });

  it('treats missing severity tag as null', () => {
    const raw = `---
id: x
name: x
scope: whole-app
feature: null
agentName: qa-hunter
generatedAt: 2026-05-05T20:00:00Z
generatedBy: manual
version: 1
---

## A
- [ ] No severity here
`;
    const blocks = parsePlanFile(raw).blocks;
    expect(blocks[1]!.kind).toBe('case');
    if (blocks[1]!.kind === 'case') expect(blocks[1]!.severity).toBeNull();
  });

  it('drops sub-bullets that are not Expected or Repro', () => {
    const raw = `---
id: x
name: x
scope: whole-app
feature: null
agentName: qa-hunter
generatedAt: 2026-05-05T20:00:00Z
generatedBy: manual
version: 1
---

## A
- [ ] Something
  - **Expected:** ok
  - just a bullet
`;
    const c = parsePlanFile(raw).blocks[1]!;
    if (c.kind === 'case') {
      expect(c.expected).toBe('ok');
      expect(c.repro).toBeNull();
    }
  });

  it('refuses to parse without a frontmatter id', () => {
    const raw = `---
scope: whole-app
---

## A
- [ ] X
`;
    expect(() => parsePlanFile(raw)).toThrow(/required `id`/);
  });

  it('serializer quotes titles containing colons', () => {
    const fm: TestPlanFrontmatter = {
      id: 'x',
      name: 'Tricky: name',
      scope: 'whole-app',
      feature: null,
      agentName: 'qa-hunter',
      generatedAt: '2026-05-05T20:00:00Z',
      generatedBy: 'manual',
      version: 1,
    };
    const md = serializePlan(fm, []);
    expect(md).toContain('name: "Tricky: name"');
  });
});
