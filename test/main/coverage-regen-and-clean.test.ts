import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { handleCoverageCleanStaleLabels } from '../../src/main/ipc/coverage';
import { extractFeatures } from '../../src/main/coverage/generate-map';

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-cov-regen-'));
  repoPath = join(tmp, 'repo');
  mkdirSync(repoPath, { recursive: true });
  for (const f of [
    'src/auth/index.ts',
    'src/auth/middleware.ts',
    'src/checkout/cart.ts',
    'src/checkout/pay.ts',
    'src/settings/index.ts',
  ]) {
    const full = join(repoPath, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.add('.');
  await git.commit('initial');

  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/regen',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('extractFeatures parser', () => {
  it('returns the JSON inside BEGIN_COVERAGE_MAP markers', () => {
    const stdout = `noise before
BEGIN_COVERAGE_MAP
{
  "features": [
    { "label": "auth", "globs": ["src/auth/**"] },
    { "label": "checkout", "globs": ["src/checkout/**"] }
  ]
}
END_COVERAGE_MAP
noise after`;
    const result = extractFeatures(stdout);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result!.map((f) => f.label)).toEqual(['auth', 'checkout']);
  });
});

describe('coverage:cleanStaleLabels', () => {
  it('removes labels whose globs match zero tracked files', async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(
      mapPath,
      [
        '# Coverage map',
        '',
        '- `auth`: `src/auth/**`',
        '- `checkout`: `src/checkout/**`',
        '- `bogus1`: `src/totally-fake/**`',
        '- `bogus2`: `**/nope/**`',
        '- `settings`: `src/settings/**`',
        '',
      ].join('\n'),
    );

    const res = await handleCoverageCleanStaleLabels({ repoId });
    expect(res.removed.sort()).toEqual(['bogus1', 'bogus2']);

    const fresh = readFileSync(mapPath, 'utf8');
    expect(fresh).toContain('`auth`');
    expect(fresh).toContain('`checkout`');
    expect(fresh).toContain('`settings`');
    expect(fresh).not.toContain('`bogus1`');
    expect(fresh).not.toContain('`bogus2`');
  });

  it("returns removed: [] when the map has no stale labels", async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(
      mapPath,
      '# Coverage map\n\n- `auth`: `src/auth/**`\n- `checkout`: `src/checkout/**`\n',
    );
    const before = readFileSync(mapPath, 'utf8');
    const res = await handleCoverageCleanStaleLabels({ repoId });
    expect(res.removed).toEqual([]);
    // File is untouched when nothing to remove.
    expect(readFileSync(mapPath, 'utf8')).toBe(before);
  });

  it('removes explicit labels when `labels` array is supplied', async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(
      mapPath,
      '# Coverage map\n\n- `auth`: `src/auth/**`\n- `checkout`: `src/checkout/**`\n- `settings`: `src/settings/**`\n',
    );
    const res = await handleCoverageCleanStaleLabels({ repoId, labels: ['checkout'] });
    expect(res.removed).toEqual(['checkout']);
    const fresh = readFileSync(mapPath, 'utf8');
    expect(fresh).toContain('`auth`');
    expect(fresh).not.toContain('`checkout`');
    expect(fresh).toContain('`settings`');
  });

  it("returns removed: [] when qa/coverage-map.md doesn't exist", async () => {
    const res = await handleCoverageCleanStaleLabels({ repoId });
    expect(res.removed).toEqual([]);
    expect(existsSync(join(repoPath, 'qa', 'coverage-map.md'))).toBe(false);
  });
});
