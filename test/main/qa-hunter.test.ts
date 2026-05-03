import { describe, it, expect } from 'vitest';
import { parseFindings } from '../../src/main/agents/qa-hunter';

describe('parseFindings', () => {
  it('extracts findings from a fenced BEGIN_FINDINGS block', () => {
    const stdout = `Some reasoning…

BEGIN_FINDINGS
[
  {
    "title": "Race in session refresh",
    "severity": "P1",
    "repro": "Open Safari, refresh after 30s.",
    "suspected_files": ["src/auth/session.ts:142"],
    "suggested_test": "describe('refresh', () => { it('handles strict cookies', ...) })"
  },
  {
    "title": "Missing input validation on POST /reports",
    "severity": "P0",
    "repro": "POST {} → 500.",
    "suspected_files": ["src/routes/reports.ts:23"],
    "suggested_test": "POST should reject body without required fields"
  }
]
END_FINDINGS

…more reasoning`;
    const findings = parseFindings(stdout);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.severity).toBe('P1');
    expect(findings[1]!.severity).toBe('P0');
  });

  it('returns [] when no fenced block is present', () => {
    expect(parseFindings('just prose, nothing structured')).toEqual([]);
  });

  it('returns [] for an empty findings array', () => {
    expect(parseFindings('BEGIN_FINDINGS\n[]\nEND_FINDINGS')).toEqual([]);
  });

  it('skips entries that fail the shape check', () => {
    const stdout = `BEGIN_FINDINGS
[
  { "title": "ok", "severity": "P1", "repro": "x", "suspected_files": ["a"], "suggested_test": "t" },
  { "title": "missing severity field" },
  { "title": "bad severity", "severity": "high", "repro": "x", "suspected_files": [], "suggested_test": "t" }
]
END_FINDINGS`;
    const findings = parseFindings(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe('ok');
  });

  it('returns [] on malformed JSON', () => {
    expect(parseFindings('BEGIN_FINDINGS\n[broken JSON\nEND_FINDINGS')).toEqual([]);
  });
});
