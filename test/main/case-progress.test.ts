import { describe, it, expect } from 'vitest';
import {
  CaseProgressTracker,
  parseCaseProgressLine,
  resolveCaseId,
  type CaseRef,
} from '../../src/main/orchestrator/case-progress';
import type { CaseProgressState } from '../../src/shared/types';

describe('parseCaseProgressLine', () => {
  it('parses the four canonical marker shapes', () => {
    expect(parseCaseProgressLine('CASE_START 01HZX')).toEqual({
      caseId: '01HZX',
      status: 'running',
    });
    expect(parseCaseProgressLine('CASE_PASS 01HZX')).toEqual({
      caseId: '01HZX',
      status: 'passed',
    });
    expect(parseCaseProgressLine('CASE_FAIL 01HZX')).toEqual({
      caseId: '01HZX',
      status: 'failed',
    });
    expect(parseCaseProgressLine('CASE_INCONCLUSIVE 01HZX')).toEqual({
      caseId: '01HZX',
      status: 'inconclusive',
    });
  });

  it('tolerates leading whitespace and Markdown-bold wrapping', () => {
    expect(parseCaseProgressLine('   **CASE_PASS abc**   ')).toEqual({
      caseId: 'abc',
      status: 'passed',
    });
  });

  it('tolerates a colon between keyword and id', () => {
    expect(parseCaseProgressLine('CASE_FAIL: foo')).toEqual({
      caseId: 'foo',
      status: 'failed',
    });
  });

  it('captures a parenthetical reason as detail', () => {
    expect(parseCaseProgressLine('CASE_INCONCLUSIVE abc (no fixture available)')).toEqual({
      caseId: 'abc',
      status: 'inconclusive',
      detail: 'no fixture available',
    });
  });

  it('case-insensitive keyword', () => {
    expect(parseCaseProgressLine('case_pass xyz')).toEqual({
      caseId: 'xyz',
      status: 'passed',
    });
  });

  it('returns null for non-marker lines', () => {
    expect(parseCaseProgressLine('this is just reasoning prose')).toBeNull();
    expect(parseCaseProgressLine('BEGIN_FINDINGS')).toBeNull();
    expect(parseCaseProgressLine('CASE_FAIL')).toBeNull(); // no id
    expect(parseCaseProgressLine('')).toBeNull();
  });
});

describe('CaseProgressTracker', () => {
  it('fires onTransition for each newline-terminated marker', () => {
    const events: { caseId: string; status: CaseProgressState }[] = [];
    const t = new CaseProgressTracker((e) => events.push({ caseId: e.caseId, status: e.status }));
    t.feedChunk('CASE_START a\nsome reasoning text\nCASE_PASS a\n');
    expect(events).toEqual([
      { caseId: 'a', status: 'running' },
      { caseId: 'a', status: 'passed' },
    ]);
  });

  it('handles markers split across chunks (partial buffer)', () => {
    const events: { caseId: string; status: CaseProgressState }[] = [];
    const t = new CaseProgressTracker((e) => events.push({ caseId: e.caseId, status: e.status }));
    t.feedChunk('CASE_S');
    t.feedChunk('TART zzz\n');
    expect(events).toEqual([{ caseId: 'zzz', status: 'running' }]);
  });

  it('flush() drains an unterminated trailing line', () => {
    const events: { caseId: string; status: CaseProgressState }[] = [];
    const t = new CaseProgressTracker((e) => events.push({ caseId: e.caseId, status: e.status }));
    t.feedChunk('CASE_PASS final');
    expect(events).toEqual([]);
    t.flush();
    expect(events).toEqual([{ caseId: 'final', status: 'passed' }]);
  });

  it('feedLine() bypasses the buffer for direct line input', () => {
    const events: { caseId: string; status: CaseProgressState }[] = [];
    const t = new CaseProgressTracker((e) => events.push({ caseId: e.caseId, status: e.status }));
    t.feedLine('CASE_FAIL one');
    t.feedLine('not a marker');
    t.feedLine('CASE_PASS two');
    expect(events).toEqual([
      { caseId: 'one', status: 'failed' },
      { caseId: 'two', status: 'passed' },
    ]);
  });
});

describe('resolveCaseId', () => {
  const refs: CaseRef[] = [
    { caseId: '01KS6FS17CAZAAGGZGX0BMX9B0', slotId: 'C1', caseTitle: 'First case' },
    { caseId: '01KS6FS17CDTJA6T9048X0FB69', slotId: 'C2', caseTitle: 'Second case' },
    { caseId: '01KS6FS17CZM3KNJ1QBDARDZ15', slotId: 'C3', caseTitle: 'Third case' },
  ];

  it('returns exact-ULID match', () => {
    expect(resolveCaseId('01KS6FS17CDTJA6T9048X0FB69', refs)).toEqual({
      caseId: '01KS6FS17CDTJA6T9048X0FB69',
      resolvedBy: 'exact',
    });
  });

  it('returns slot-id match when the agent quoted `C1`', () => {
    expect(resolveCaseId('C2', refs)).toEqual({
      caseId: '01KS6FS17CDTJA6T9048X0FB69',
      resolvedBy: 'slot',
    });
  });

  it('slot match is case-insensitive', () => {
    expect(resolveCaseId('c3', refs)?.caseId).toBe('01KS6FS17CZM3KNJ1QBDARDZ15');
  });

  it('returns prefix match when the agent truncated the ULID', () => {
    expect(resolveCaseId('01KS6FS17CAZAA', refs)).toEqual({
      caseId: '01KS6FS17CAZAAGGZGX0BMX9B0',
      resolvedBy: 'prefix',
    });
  });

  it('refuses ambiguous prefix matches', () => {
    // All three start with `01KS6FS17C…` — too short to disambiguate.
    expect(resolveCaseId('01KS6FS17C', refs)).toBeNull();
  });

  it('refuses prefix matches shorter than the minimum length', () => {
    expect(resolveCaseId('01KS6FS1', refs)).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    expect(resolveCaseId('not-in-plan-A', refs)).toBeNull();
    expect(resolveCaseId('', refs)).toBeNull();
    expect(resolveCaseId('extra-1', refs)).toBeNull();
  });

  it('returns null when the slot id has no matching case', () => {
    expect(resolveCaseId('C99', refs)).toBeNull();
  });

  it('regression: 32 wrong ULIDs replay (Image #16) — none should resolve under exact-match alone', () => {
    // Reproduces the production failure: the agent emitted 32 ULIDs that
    // share the timestamp prefix `01KS6FS17` but are otherwise different.
    // Without the resolver they all became orphans → 32/32 Skipped.
    // With Layer A's slot ids in the prompt the agent will quote `C1`..`C32`
    // instead; here we just verify the resolver doesn't falsely match
    // hallucinated full ULIDs against the wrong plan id.
    const hallucinated = '01KS6FS17NONEMATCHXX00000Z';
    expect(resolveCaseId(hallucinated, refs)).toBeNull();
  });
});
