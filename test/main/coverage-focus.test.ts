import { describe, expect, it } from 'vitest';
import { pickFocusFiles } from '../../src/main/coverage/aggregate';
import type { CoverageReport, CoverageEntry } from '../../src/shared/types';

function entry(p: Partial<CoverageEntry> & { path: string }): CoverageEntry {
  return {
    path: p.path,
    caseCount: p.caseCount ?? 0,
    findingsCount: p.findingsCount ?? 0,
    lastPassedAt: p.lastPassedAt ?? null,
    churnSinceLastPass: p.churnSinceLastPass ?? 0,
  };
}

function report(files: CoverageEntry[]): CoverageReport {
  const covered = files.filter((f) => f.caseCount > 0).length;
  return {
    repoId: 'r1',
    files,
    labels: [],
    totalFiles: files.length,
    coveredFiles: covered,
    uncoveredFiles: files.length - covered,
    lastDoneAt: null,
  };
}

describe('pickFocusFiles', () => {
  it('returns [] when nothing needs attention', () => {
    const r = report([
      entry({ path: 'a.ts', caseCount: 5 }),
      entry({ path: 'b.ts', caseCount: 3 }),
    ]);
    expect(pickFocusFiles(r)).toEqual([]);
  });

  it('open-findings rank above churn-with-no-coverage which ranks above plain churn which ranks above plain uncovered', () => {
    const r = report([
      entry({ path: 'covered-stable.ts', caseCount: 5 }), // skipped
      entry({ path: 'plain-uncovered.ts', caseCount: 0 }),
      entry({ path: 'churn-covered.ts', caseCount: 4, churnSinceLastPass: 3 }),
      entry({ path: 'uncovered-with-churn.ts', caseCount: 0, churnSinceLastPass: 2 }),
      entry({ path: 'has-finding.ts', caseCount: 1, findingsCount: 2 }),
    ]);
    const out = pickFocusFiles(r);
    expect(out.map((f) => f.path)).toEqual([
      'has-finding.ts',
      'uncovered-with-churn.ts',
      'churn-covered.ts',
      'plain-uncovered.ts',
    ]);
    expect(out[0]!.reason).toBe('open-findings');
    expect(out[1]!.reason).toBe('uncovered-with-churn');
    expect(out[2]!.reason).toBe('churn-since-pass');
    expect(out[3]!.reason).toBe('uncovered');
  });

  it('within a tier, higher findings/churn win and lower coverage wins ties', () => {
    const r = report([
      entry({ path: 'low.ts', caseCount: 0, churnSinceLastPass: 1 }),
      entry({ path: 'high.ts', caseCount: 0, churnSinceLastPass: 12 }),
    ]);
    const out = pickFocusFiles(r);
    expect(out[0]!.path).toBe('high.ts');
  });

  it('caps the list at the limit argument', () => {
    const files: CoverageEntry[] = [];
    for (let i = 0; i < 50; i++) {
      files.push(entry({ path: `f${i}.ts`, caseCount: 0 }));
    }
    const out = pickFocusFiles(report(files), 10);
    expect(out).toHaveLength(10);
  });

  it('skips covered files with no churn and no findings (not actionable)', () => {
    const r = report([
      entry({ path: 'fine.ts', caseCount: 5, churnSinceLastPass: 0, findingsCount: 0 }),
    ]);
    expect(pickFocusFiles(r)).toEqual([]);
  });
});
