import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFromTrackedFiles } from '../../src/main/coverage/feature-scan';

/**
 * Pure-function tests for the feature scanner. No DB / git needed — we
 * feed in a tracked-files list and assert what labels come out.
 */

function mkRepo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-fs-'));
  for (const f of files) {
    const full = join(root, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  return root;
}

describe('scanFromTrackedFiles', () => {
  it('groups files under src/<feature> as a single label when small', () => {
    const files = [
      'src/auth/session.ts',
      'src/auth/middleware.ts',
      'src/auth/types.ts',
      'src/billing/charge.ts',
      'src/billing/refund.ts',
      'src/billing/types.ts',
    ];
    const repo = mkRepo(files);
    try {
      const result = scanFromTrackedFiles(repo, files);
      const labels = result.map((r) => r.label).sort();
      expect(labels).toContain('auth');
      expect(labels).toContain('billing');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('splits a large feature into sub-features when 2+ sub-dirs are viable', () => {
    // src/wealthlab has 12 files split across 3 sub-dirs, each with 4 files —
    // the scanner should emit charts/data/auth instead of one big wealthlab.
    const files = [
      ...['a', 'b', 'c', 'd'].map((n) => `src/wealthlab/charts/${n}.ts`),
      ...['a', 'b', 'c', 'd'].map((n) => `src/wealthlab/data/${n}.ts`),
      ...['a', 'b', 'c', 'd'].map((n) => `src/wealthlab/auth/${n}.ts`),
    ];
    const repo = mkRepo(files);
    try {
      const result = scanFromTrackedFiles(repo, files);
      const labels = result.map((r) => r.label);
      expect(labels).toContain('charts');
      expect(labels).toContain('data');
      expect(labels).toContain('auth');
      // The parent wealthlab is NOT emitted when we've split it.
      expect(labels).not.toContain('wealthlab');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does NOT split when only one sub-dir is viable (split needs 2+)", () => {
    // wealthlab has lots of files but only one big subdir; keep as a single
    // wealthlab label so we don't surface a meaningless one-axis split.
    const files = [
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => `src/wealthlab/charts/${n}.ts`),
      'src/wealthlab/single.ts',
      'src/wealthlab/another.ts',
    ];
    const repo = mkRepo(files);
    try {
      const result = scanFromTrackedFiles(repo, files);
      const labels = result.map((r) => r.label);
      // Only one viable subdir → keep the parent label intact.
      expect(labels).toContain('wealthlab');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('handles a mixed repo — small features stay flat, big ones split', () => {
    const files = [
      // Small flat features.
      'src/auth/a.ts',
      'src/auth/b.ts',
      'src/auth/c.ts',
      'src/billing/a.ts',
      'src/billing/b.ts',
      'src/billing/c.ts',
      // Big feature with sub-dirs → splits.
      ...['a', 'b', 'c', 'd'].map((n) => `src/wealthlab/charts/${n}.ts`),
      ...['a', 'b', 'c', 'd'].map((n) => `src/wealthlab/data/${n}.ts`),
    ];
    const repo = mkRepo(files);
    try {
      const result = scanFromTrackedFiles(repo, files);
      const labels = new Set(result.map((r) => r.label));
      expect(labels.has('auth')).toBe(true);
      expect(labels.has('billing')).toBe(true);
      expect(labels.has('charts')).toBe(true);
      expect(labels.has('data')).toBe(true);
      expect(labels.has('wealthlab')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
