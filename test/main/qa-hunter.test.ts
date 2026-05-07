import { describe, it, expect } from 'vitest';
import { parseFindings } from '../../src/main/agents/qa-hunter';

const RICH_FINDING = {
  title: 'Race in session refresh',
  severity: 'P1',
  description:
    'When Safari refreshes the session with strict cookies enabled, the silent refresh handler reads a missing Set-Cookie as success and clears the in-memory token, signing the user out mid-session.',
  expected: 'User stays signed in after a 30s idle on Safari.',
  actual: 'User is redirected to /login after a 30s idle on Safari.',
  repro: '1. Open Safari with strict cookies. 2. Sign in. 3. Idle 30s. 4. Click any authenticated link.',
  evidence: 'src/auth/session.ts:142 calls readCookie() unconditionally on a 200 response and assigns null when Safari omits Set-Cookie.',
  suspected_files: ['src/auth/session.ts:142'],
  suggested_test: "describe('refresh', () => { it('handles strict cookies', () => { /* … */ }) })",
};

const SECOND_FINDING = {
  title: 'Missing input validation on POST /reports',
  severity: 'P0',
  description:
    'POST /reports does not validate the request body. An empty payload reaches the DB layer and triggers a 500 from a NOT NULL violation, but the handler never returns a structured error to the caller.',
  expected: 'POST /reports with an empty body returns a 400 describing the missing fields.',
  actual: 'POST /reports with an empty body returns a 500 with no body.',
  repro: '1. Hit `POST /reports` with `{}` and a valid auth token. 2. Observe 500 + empty body in the response.',
  evidence: 'src/routes/reports.ts:23 destructures `name` and `period` from `req.body` without a guard; the DB insert throws on NOT NULL.',
  suspected_files: ['src/routes/reports.ts:23'],
  suggested_test: 'POST should reject body without required fields and return 400.',
};

describe('parseFindings', () => {
  it('extracts findings from a fenced BEGIN_FINDINGS block', () => {
    const stdout = `Some reasoning…

BEGIN_FINDINGS
${JSON.stringify([RICH_FINDING, SECOND_FINDING], null, 2)}
END_FINDINGS

…more reasoning`;
    const findings = parseFindings(stdout);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.severity).toBe('P1');
    expect(findings[0]!.description).toContain('Safari');
    expect(findings[0]!.expected).toContain('signed in');
    expect(findings[0]!.actual).toContain('/login');
    expect(findings[1]!.severity).toBe('P0');
  });

  it('returns [] when no fenced block is present', () => {
    expect(parseFindings('just prose, nothing structured')).toEqual([]);
  });

  it('returns [] for an empty findings array', () => {
    expect(parseFindings('BEGIN_FINDINGS\n[]\nEND_FINDINGS')).toEqual([]);
  });

  it('skips entries that fail the shape check', () => {
    const missingExpected = { ...RICH_FINDING, title: 'no expected', expected: '' };
    const badSeverity = { ...RICH_FINDING, title: 'bad severity', severity: 'high' };
    const missingDescription = { ...RICH_FINDING, title: 'no description', description: '' };
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([RICH_FINDING, missingExpected, badSeverity, missingDescription, { title: 'just title' }], null, 2)}
END_FINDINGS`;
    const findings = parseFindings(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe('Race in session refresh');
  });

  it('accepts findings without an evidence field (evidence is optional)', () => {
    const noEvidence = { ...RICH_FINDING };
    delete (noEvidence as { evidence?: string }).evidence;
    const stdout = `BEGIN_FINDINGS\n${JSON.stringify([noEvidence])}\nEND_FINDINGS`;
    const findings = parseFindings(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toBeUndefined();
  });

  it('returns [] on malformed JSON', () => {
    expect(parseFindings('BEGIN_FINDINGS\n[broken JSON\nEND_FINDINGS')).toEqual([]);
  });
});
