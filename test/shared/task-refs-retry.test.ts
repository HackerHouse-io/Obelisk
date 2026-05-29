import { describe, it, expect } from 'vitest';
import { parseBacklogTaskRef, parsePrTaskRef } from '../../src/shared/task-refs';

describe('parseBacklogTaskRef', () => {
  it('decodes issue refs', () => {
    expect(parseBacklogTaskRef('issue#42')).toEqual({ kind: 'issue', issueNumber: 42 });
  });

  it('decodes backlog refs (ULID body kept verbatim)', () => {
    expect(parseBacklogTaskRef('backlog#01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({
      kind: 'backlog',
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });

  it('returns null for non-backlog refs', () => {
    expect(parseBacklogTaskRef('pr#62@7b3b7ab41282')).toBeNull();
    expect(parseBacklogTaskRef('plan:full-app')).toBeNull();
    expect(parseBacklogTaskRef(null)).toBeNull();
    expect(parseBacklogTaskRef('issue#')).toBeNull();
  });
});

describe('parsePrTaskRef', () => {
  it('decodes pr refs', () => {
    expect(parsePrTaskRef('pr#62@7b3b7ab41282')).toEqual({
      prNumber: 62,
      shortSha: '7b3b7ab41282',
    });
  });

  it('returns null for non-pr refs', () => {
    expect(parsePrTaskRef('issue#42')).toBeNull();
    expect(parsePrTaskRef('plan:full-app')).toBeNull();
    expect(parsePrTaskRef(null)).toBeNull();
    expect(parsePrTaskRef('pr#62')).toBeNull();
  });
});
