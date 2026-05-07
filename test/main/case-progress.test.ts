import { describe, it, expect } from 'vitest';
import {
  CaseProgressTracker,
  parseCaseProgressLine,
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
