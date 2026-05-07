import { describe, expect, it } from 'vitest';
import {
  matchesGlob,
  matchesAnyGlob,
  parseCoverageMap,
  resolveScopeToGlobs,
} from '../../src/main/coverage/coverage-map';

describe('parseCoverageMap', () => {
  it('parses a simple list of `label: glob[, glob]`', () => {
    const map = parseCoverageMap(`
# Coverage map

- \`auth\`: \`src/auth/**\`, \`src/middleware/auth*.ts\`
- \`checkout\`: \`src/checkout/**\`
- onboarding: src/onboarding/**, src/RootView.swift
`);
    expect(map.get('auth')).toEqual(['src/auth/**', 'src/middleware/auth*.ts']);
    expect(map.get('checkout')).toEqual(['src/checkout/**']);
    expect(map.get('onboarding')).toEqual(['src/onboarding/**', 'src/RootView.swift']);
  });

  it('accepts both : and → as separators', () => {
    const map = parseCoverageMap('- billing → src/billing/**');
    expect(map.get('billing')).toEqual(['src/billing/**']);
  });

  it('lowercases labels but preserves glob casing', () => {
    const map = parseCoverageMap('- Auth: src/Auth/**');
    expect(map.get('auth')).toEqual(['src/Auth/**']);
    expect(map.has('Auth')).toBe(false);
  });

  it('skips non-list lines', () => {
    const map = parseCoverageMap(`
just prose, no list

- auth: src/auth/**

more prose
`);
    expect(map.size).toBe(1);
  });

  it('returns empty for blank input', () => {
    expect(parseCoverageMap('').size).toBe(0);
  });
});

describe('matchesGlob', () => {
  it('handles single-star segment matching', () => {
    expect(matchesGlob('src/auth/session.ts', 'src/auth/*.ts')).toBe(true);
    expect(matchesGlob('src/auth/internal/session.ts', 'src/auth/*.ts')).toBe(false);
  });

  it('handles double-star recursive matching', () => {
    expect(matchesGlob('src/auth/internal/session.ts', 'src/auth/**')).toBe(true);
    expect(matchesGlob('src/auth/session.ts', 'src/auth/**')).toBe(true);
    expect(matchesGlob('src/billing/session.ts', 'src/auth/**')).toBe(false);
  });

  it('handles literal paths without wildcards', () => {
    expect(matchesGlob('src/RootView.swift', 'src/RootView.swift')).toBe(true);
    expect(matchesGlob('src/RootView.swift', 'src/Other.swift')).toBe(false);
  });

  it('matchesAnyGlob short-circuits on first match', () => {
    expect(matchesAnyGlob('src/auth/session.ts', ['src/billing/**', 'src/auth/**'])).toBe(true);
    expect(matchesAnyGlob('src/auth/session.ts', ['src/billing/**'])).toBe(false);
  });
});

describe('resolveScopeToGlobs', () => {
  it('uses mapped globs when label exists', () => {
    const map = new Map([['auth', ['src/auth/**']]]);
    expect(resolveScopeToGlobs(['auth'], map)).toEqual(['src/auth/**']);
  });

  it('falls back to substring globs when label is unmapped', () => {
    const globs = resolveScopeToGlobs(['checkout'], new Map());
    // Three patterns covering directory, prefix, and substring matches.
    expect(globs).toEqual(['**/checkout/**', '**/checkout*', '**/*checkout*']);
  });

  it('mixes mapped and unmapped labels in the same call', () => {
    const map = new Map([['auth', ['src/auth/**']]]);
    const globs = resolveScopeToGlobs(['auth', 'billing'], map);
    expect(globs).toContain('src/auth/**');
    expect(globs).toContain('**/billing/**');
  });

  it('label matching is case-insensitive', () => {
    const map = new Map([['auth', ['src/auth/**']]]);
    expect(resolveScopeToGlobs(['AUTH'], map)).toEqual(['src/auth/**']);
  });
});
