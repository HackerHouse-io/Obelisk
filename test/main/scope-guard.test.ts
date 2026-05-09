import { describe, expect, it } from 'vitest';
import { checkPatchScope, isGenerated, isLockfile } from '../../src/main/agents/lib/scope-guard';

describe('isLockfile', () => {
  it('matches the canonical lockfile basenames', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('apps/web/yarn.lock')).toBe(true);
    expect(isLockfile('Cargo.lock')).toBe(true);
    expect(isLockfile('vendor/Gemfile.lock')).toBe(true);
    expect(isLockfile('go.sum')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLockfile('CARGO.LOCK')).toBe(true);
  });

  it('does not match similar-looking but unrelated paths', () => {
    expect(isLockfile('src/lock-fixture.json')).toBe(false);
    expect(isLockfile('docs/about-yarn.md')).toBe(false);
    expect(isLockfile('package.json')).toBe(false);
  });
});

describe('isGenerated', () => {
  it('matches build / dist / generated dirs', () => {
    expect(isGenerated('dist/index.js')).toBe(true);
    expect(isGenerated('build/main/index.js')).toBe(true);
    expect(isGenerated('app/.next/static/x.js')).toBe(true);
    expect(isGenerated('out/main/index.js')).toBe(true);
    expect(isGenerated('src/__generated__/types.ts')).toBe(true);
  });

  it('matches *.generated.<ext> / *.gen.<ext> / *.pb.<ext>', () => {
    expect(isGenerated('src/api.generated.ts')).toBe(true);
    expect(isGenerated('schema.gen.go')).toBe(true);
    expect(isGenerated('proto/foo.pb.go')).toBe(true);
  });

  it('does not match plausible source code', () => {
    expect(isGenerated('src/distance.ts')).toBe(false);
    expect(isGenerated('docs/build.md')).toBe(false);
    expect(isGenerated('src/lib/output.ts')).toBe(false);
  });
});

describe('checkPatchScope', () => {
  it('passes a small in-bounds patch', () => {
    const r = checkPatchScope(['src/a.ts', 'src/b.ts'], { maxFiles: 5 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('rejects when file count exceeds the cap', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const r = checkPatchScope(files, { maxFiles: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_many_files');
    expect(r.detail).toMatch(/touched 6 files/);
    expect(r.offending).toEqual(files);
  });

  it('rejects any blacklisted lockfile even when under the file count cap', () => {
    const r = checkPatchScope(['src/a.ts', 'pnpm-lock.yaml'], { maxFiles: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blacklisted_path');
    expect(r.offending).toEqual(['pnpm-lock.yaml']);
  });

  it('rejects generated paths regardless of count', () => {
    const r = checkPatchScope(['dist/index.js'], { maxFiles: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blacklisted_path');
  });

  it('lists multiple blacklisted offenders in detail', () => {
    const r = checkPatchScope(['package-lock.json', 'yarn.lock', 'src/a.ts', 'dist/x.js'], {
      maxFiles: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blacklisted_path');
    expect(r.offending).toContain('package-lock.json');
    expect(r.offending).toContain('yarn.lock');
    expect(r.offending).toContain('dist/x.js');
    // src/a.ts is fine — only blacklisted entries should appear.
    expect(r.offending).not.toContain('src/a.ts');
  });

  it('respects the per-repo cap override (lower = stricter)', () => {
    const r = checkPatchScope(['a.ts', 'b.ts', 'c.ts'], { maxFiles: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_many_files');
    expect(r.detail).toMatch(/cap is 2/);
  });

  it('clamps invalid caps to a usable minimum', () => {
    const r = checkPatchScope(['a.ts'], { maxFiles: 0 });
    expect(r.ok).toBe(true); // 1 file ≤ clamped min of 1
  });
});
