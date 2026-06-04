import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSectionMemoryUpdate,
  applySectionMemoryUpdate,
  readSectionMemory,
} from '../../src/main/util/section-memory';
import {
  parseUxMemoryUpdate,
  applyUxMemoryUpdate,
  readUxMemory,
  uxMemoryRelPath,
} from '../../src/main/agents/ux-expert/memory';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-uxmem-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('section-memory engine', () => {
  const BEGIN = 'BEGIN_UX_MEMORY_UPDATE';
  const END = 'END_UX_MEMORY_UPDATE';

  it('parses the last block when several are present (in-context example does not win)', () => {
    const reasoning = [
      `Example: ${BEGIN}\n## Selectors\n- example\n${END}`,
      'reasoning…',
      `${BEGIN}\n## Selectors\n- real: button name "Save"\n${END}`,
    ].join('\n\n');
    const update = parseSectionMemoryUpdate(reasoning, BEGIN, END);
    expect(update).toContain('button name "Save"');
    expect(update).not.toContain('- example');
  });

  it('returns null when no block / empty body', () => {
    expect(parseSectionMemoryUpdate('no block here', BEGIN, END)).toBeNull();
    expect(parseSectionMemoryUpdate(`${BEGIN}\n\n${END}`, BEGIN, END)).toBeNull();
  });

  it('replaces a same-titled H2 section, appends new ones, preserves preamble', () => {
    const file = join(tmp, 'mem.md');
    applySectionMemoryUpdate(file, '## Navigation map\n- home: /\n## Selectors\n- a');
    applySectionMemoryUpdate(file, '## Selectors\n- b (updated)\n## App shell\n- nav x');
    const out = readFileSync(file, 'utf8');
    // Navigation map untouched, Selectors replaced (not duplicated), App shell appended.
    expect(out).toContain('## Navigation map\n\n- home: /');
    expect(out).toContain('- b (updated)');
    expect(out).not.toContain('- a');
    expect(out.match(/## Selectors/g)).toHaveLength(1);
    expect(out).toContain('## App shell');
  });

  it('readSectionMemory caps oversized files', () => {
    const file = join(tmp, 'big.md');
    const big = '## X\n' + Array.from({ length: 2000 }, (_, i) => `- line ${i}`).join('\n');
    applySectionMemoryUpdate(file, big);
    const read = readSectionMemory(file, 1024);
    expect(read.length).toBeLessThan(1300);
    expect(read).toContain('truncated');
  });

  it('readSectionMemory returns empty string when missing', () => {
    expect(readSectionMemory(join(tmp, 'nope.md'))).toBe('');
  });
});

describe('ux-expert per-plan memory', () => {
  it('writes to qa/ux-memory/<planId>.md and reads it back', () => {
    applyUxMemoryUpdate(tmp, '01HPLAN', '## Navigation map\n- billing: /settings → Billing');
    const rel = uxMemoryRelPath('01HPLAN');
    expect(rel).toBe('qa/ux-memory/01HPLAN.md');
    expect(existsSync(join(tmp, rel))).toBe(true);
    expect(readUxMemory(tmp, '01HPLAN')).toContain('billing: /settings');
  });

  it('keeps memory per-plan (two plans do not collide)', () => {
    applyUxMemoryUpdate(tmp, 'planA', '## Selectors\n- A');
    applyUxMemoryUpdate(tmp, 'planB', '## Selectors\n- B');
    expect(readUxMemory(tmp, 'planA')).toContain('- A');
    expect(readUxMemory(tmp, 'planA')).not.toContain('- B');
    expect(readUxMemory(tmp, 'planB')).toContain('- B');
  });

  it('sanitizes unsafe plan ids into a single path segment', () => {
    // Slashes (the traversal vector) become underscores → always a single
    // path segment. Dots are harmless without a slash.
    expect(uxMemoryRelPath('../../etc/passwd')).toBe('qa/ux-memory/.._.._etc_passwd.md');
    expect(uxMemoryRelPath('plan:weird/id')).toBe('qa/ux-memory/plan_weird_id.md');
    expect(uxMemoryRelPath('../../etc/passwd')).not.toContain('/etc/');
  });

  it('parseUxMemoryUpdate extracts the block', () => {
    const r = `prose\nBEGIN_UX_MEMORY_UPDATE\n## Selectors\n- x\nEND_UX_MEMORY_UPDATE`;
    expect(parseUxMemoryUpdate(r)).toBe('## Selectors\n- x');
  });
});
