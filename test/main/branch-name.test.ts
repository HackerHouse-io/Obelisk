import { describe, expect, it } from 'vitest';
import { buildBranchName } from '../../src/main/git/branch-name';

describe('buildBranchName', () => {
  it('slugifies the PR title and appends a short runId suffix', () => {
    const branch = buildBranchName(
      'fix: Product load failure still shows purchasable hard-coded prices',
      '01KSRFB3T8G7QNZYYVRYTGF270',
    );
    expect(branch).toBe('obelisk/fix-product-load-failure-still-shows-purchasable-ytgf270');
  });

  it('lowercases and collapses non-alphanumerics into single hyphens', () => {
    const branch = buildBranchName('Feat!! Add  OAuth (Google) login', '01HXabcDEF');
    expect(branch).toMatch(/^obelisk\/feat-add-oauth-google-login-[a-z0-9]+$/);
    expect(branch).not.toMatch(/[A-Z]/);
    expect(branch).not.toMatch(/--/);
  });

  it('keeps the slug bounded so branch names stay readable', () => {
    const long = 'fix: ' + 'word '.repeat(40);
    const branch = buildBranchName(long, '01HX0000001');
    const slug = branch.replace(/^obelisk\//, '').replace(/-[a-z0-9]+$/, '');
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it('produces distinct branches for the same title across different runs', () => {
    const a = buildBranchName('fix: same title', '01AAAAAAAAAA1111');
    const b = buildBranchName('fix: same title', '01BBBBBBBBBB2222');
    expect(a).not.toBe(b);
  });

  it('falls back to a non-empty slug when the title has no alphanumerics', () => {
    const branch = buildBranchName('!!! ---', '01HXrunid99');
    expect(branch).toMatch(/^obelisk\/change-[a-z0-9]+$/);
  });
});
