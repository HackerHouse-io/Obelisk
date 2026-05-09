import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMemoryUpdate,
  parseMemoryUpdate,
  scaffoldMemoryFile,
  MEMORY_FILE_REL,
} from '../../../../src/main/agents/ios-qa-pilot/memory';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-ios-mem-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseMemoryUpdate', () => {
  it('returns null when no markers are present', () => {
    expect(parseMemoryUpdate('just stdout, no markers')).toBeNull();
    expect(parseMemoryUpdate('')).toBeNull();
    expect(parseMemoryUpdate(null)).toBeNull();
    expect(parseMemoryUpdate(undefined)).toBeNull();
  });

  it('extracts the body between BEGIN_IOS_MEMORY_UPDATE and END_IOS_MEMORY_UPDATE', () => {
    const stdout = `
some prose

BEGIN_IOS_MEMORY_UPDATE
## App architecture
- Tab bar has 4 tabs.

## Useful selectors
- Login: \`cta-login\`
END_IOS_MEMORY_UPDATE

other prose
`;
    const out = parseMemoryUpdate(stdout)!;
    expect(out).toContain('## App architecture');
    expect(out).toContain('Tab bar has 4 tabs');
    expect(out).toContain('## Useful selectors');
    expect(out).not.toContain('BEGIN_IOS_MEMORY_UPDATE');
    expect(out).not.toContain('END_IOS_MEMORY_UPDATE');
  });

  it('returns the LAST block when multiple blocks appear (so an in-context example before the real end-of-run block does not win)', () => {
    const stdout = `
BEGIN_IOS_MEMORY_UPDATE
## App architecture
- Earlier example block (should be ignored)
END_IOS_MEMORY_UPDATE

later reasoning

BEGIN_IOS_MEMORY_UPDATE
## App architecture
- Real end-of-run content
END_IOS_MEMORY_UPDATE
`;
    expect(parseMemoryUpdate(stdout)).toContain('Real end-of-run content');
    expect(parseMemoryUpdate(stdout)).not.toContain('Earlier example block');
  });

  it('returns null for an empty block', () => {
    const stdout = `BEGIN_IOS_MEMORY_UPDATE\n   \nEND_IOS_MEMORY_UPDATE`;
    expect(parseMemoryUpdate(stdout)).toBeNull();
  });
});

describe('applyMemoryUpdate', () => {
  it('creates the file on the first call with the agent-supplied sections', () => {
    expect(existsSync(join(tmp, MEMORY_FILE_REL))).toBe(false);
    applyMemoryUpdate(
      tmp,
      ['## App architecture', '- one tab', '', '## Useful selectors', '- `cta-login`'].join('\n'),
    );
    const body = readFileSync(join(tmp, MEMORY_FILE_REL), 'utf8');
    expect(body).toContain('## App architecture');
    expect(body).toContain('- one tab');
    expect(body).toContain('## Useful selectors');
    expect(body).toContain('- `cta-login`');
    // Trailing newline policy
    expect(body.endsWith('\n')).toBe(true);
  });

  it('replaces a same-titled H2 section and appends new H2 sections', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    writeFileSync(
      join(tmp, MEMORY_FILE_REL),
      [
        '<!-- preamble -->',
        '',
        '## App architecture',
        '- old fact',
        '',
        '## Filed findings',
        '- old finding',
      ].join('\n'),
      'utf8',
    );

    applyMemoryUpdate(
      tmp,
      ['## App architecture', '- new fact', '', '## Useful selectors', '- new selector'].join('\n'),
    );

    const body = readFileSync(join(tmp, MEMORY_FILE_REL), 'utf8');
    expect(body).toContain('<!-- preamble -->');
    // App architecture replaced
    expect(body).toContain('- new fact');
    expect(body).not.toContain('- old fact');
    // Filed findings preserved (not in the update)
    expect(body).toContain('- old finding');
    // Useful selectors appended
    expect(body).toContain('- new selector');
    // Section ordering: existing first, new appended at the end
    const archIdx = body.indexOf('## App architecture');
    const filedIdx = body.indexOf('## Filed findings');
    const selIdx = body.indexOf('## Useful selectors');
    expect(archIdx).toBeLessThan(filedIdx);
    expect(filedIdx).toBeLessThan(selIdx);
  });

  it('matches H2 headings case-insensitively', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    writeFileSync(
      join(tmp, MEMORY_FILE_REL),
      ['## App Architecture', '- old fact'].join('\n'),
      'utf8',
    );
    applyMemoryUpdate(tmp, ['## app architecture', '- new fact'].join('\n'));
    const body = readFileSync(join(tmp, MEMORY_FILE_REL), 'utf8');
    expect(body).toContain('- new fact');
    expect(body).not.toContain('- old fact');
  });
});

describe('scaffoldMemoryFile', () => {
  it('creates the file with canonical headings on first call', () => {
    expect(scaffoldMemoryFile(tmp)).toBe(true);
    const body = readFileSync(join(tmp, MEMORY_FILE_REL), 'utf8');
    expect(body).toContain('## App architecture');
    expect(body).toContain('## Useful selectors');
    expect(body).toContain('## Known non-bugs');
    expect(body).toContain('## Filed findings');
  });

  it('is idempotent — never overwrites existing content', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    const userBody = '## App architecture\n- user-edited fact\n';
    writeFileSync(join(tmp, MEMORY_FILE_REL), userBody, 'utf8');
    expect(scaffoldMemoryFile(tmp)).toBe(false);
    expect(readFileSync(join(tmp, MEMORY_FILE_REL), 'utf8')).toBe(userBody);
  });
});
