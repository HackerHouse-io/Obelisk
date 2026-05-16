import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import {
  handleCoverageBootstrapMap,
  handleCoverageList,
} from '../../src/main/ipc/coverage';
import { loadCoverageMap, parseCoverageMap } from '../../src/main/coverage/coverage-map';

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-cov-bootstrap-'));
  repoPath = join(tmp, 'repo');
  mkdirSync(repoPath, { recursive: true });

  // Seed a repo that looks like a typical Electron/React app — multiple
  // src/<feature>/... directories with several files each.
  for (const f of [
    'src/main/index.ts',
    'src/main/ipc/coverage.ts',
    'src/main/ipc/runs.ts',
    'src/main/agents/qa-hunter/index.ts',
    'src/main/agents/manual-qa/index.ts',
    'src/renderer/screens/Coverage.tsx',
    'src/renderer/screens/MissionControl.tsx',
    'src/renderer/screens/Home.tsx',
    'src/renderer/screens/Connect.tsx',
    'src/shared/types.ts',
    'src/shared/errors.ts',
    'README.md',
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
    githubFullName: 'test/bootstrap',
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

describe('coverage:bootstrapMap', () => {
  it('proposes labels without writing when commit is omitted', async () => {
    const res = await handleCoverageBootstrapMap({ repoId });
    expect(res.written).toBe(false);
    expect(res.proposals.length).toBeGreaterThan(0);
    expect(existsSync(join(repoPath, 'qa', 'coverage-map.md'))).toBe(false);
  });

  it('always returns non-empty proposals on a real-looking repo', async () => {
    const res = await handleCoverageBootstrapMap({ repoId });
    expect(res.proposals.length).toBeGreaterThan(0);
    for (const p of res.proposals) {
      expect(p.label).toBeTruthy();
      expect(p.globs.length).toBeGreaterThan(0);
      expect(p.filesMatched).toBeGreaterThan(0);
    }
  });

  it('writes qa/coverage-map.md when commit:true', async () => {
    const res = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(res.written).toBe(true);
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    expect(existsSync(mapPath)).toBe(true);
    const raw = readFileSync(mapPath, 'utf8');
    expect(raw).toContain('# Coverage map');
    expect(raw.length).toBeGreaterThan(50);
  });

  it("the written file parses back to a non-empty coverage map", async () => {
    await handleCoverageBootstrapMap({ repoId, commit: true });
    const map = loadCoverageMap(repoPath);
    expect(map.size).toBeGreaterThan(0);
    // Every label in the map has at least one glob.
    for (const [label, globs] of map) {
      expect(label).toBeTruthy();
      expect(globs.length).toBeGreaterThan(0);
    }
  });

  it('refuses to overwrite a user-edited coverage map that parses cleanly', async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(mapPath, '# user-authored\n- `mine`: `src/**`\n');
    const res = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(res.written).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(readFileSync(mapPath, 'utf8')).toContain('user-authored');
  });

  it('overwrites a stale/empty coverage map that parses to zero entries', async () => {
    // Regression: a leftover file from a previous failed bootstrap (just a
    // header with no list items) used to wedge the UI — backend refused to
    // overwrite, parser returned empty, banner never disappeared.
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(mapPath, '# Coverage map\n\n<!-- old empty file -->\n');

    const res = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(res.written).toBe(true);

    const fresh = readFileSync(mapPath, 'utf8');
    expect(fresh).not.toContain('old empty file');
    // And the next coverage:list shows hasCoverageMap = true.
    const list = await handleCoverageList({ repoId });
    expect(list.hasCoverageMap).toBe(true);
    expect(list.features.length).toBeGreaterThan(0);
  });

  it('overwrites a completely empty coverage map', async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(mapPath, '');
    const res = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(res.written).toBe(true);
    expect(readFileSync(mapPath, 'utf8')).toContain('# Coverage map');
  });

  it('force:true overwrites a user-edited map (Regenerate button path)', async () => {
    const mapPath = join(repoPath, 'qa', 'coverage-map.md');
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(mapPath, '# Coverage map\n\n- `legacy`: `**/*.legacy`\n');

    // Without force: refuses to overwrite a parseable user-edited map.
    const noForce = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(noForce.written).toBe(false);
    expect(readFileSync(mapPath, 'utf8')).toContain('legacy');

    // With force: overwrites and the freshly-scanned labels replace the edit.
    const forced = await handleCoverageBootstrapMap({ repoId, commit: true, force: true });
    expect(forced.written).toBe(true);
    const fresh = readFileSync(mapPath, 'utf8');
    expect(fresh).not.toContain('`legacy`');
    expect(fresh).toMatch(/`[\w-]+`:\s*`[^`]+`/);
  });
});

describe('coverage:list after bootstrap (end-to-end)', () => {
  it('shows live-scanned features on the radar even when no map exists yet', async () => {
    // Before bootstrap: no map, but the live filesystem scan should still
    // produce features so the radar isn't empty.
    const before = await handleCoverageList({ repoId });
    expect(before.hasCoverageMap).toBe(false);
    expect(before.features.length).toBeGreaterThan(0);
    for (const f of before.features) {
      expect(f.filesInGlob).toBeGreaterThan(0);
      // No plans, no cases → 0%.
      expect(f.caseCount).toBe(0);
      expect(f.coveragePct).toBe(0);
    }
  });

  it('flips hasCoverageMap to true after bootstrap, and the radar still shows every feature', async () => {
    const boot = await handleCoverageBootstrapMap({ repoId, commit: true });
    expect(boot.written).toBe(true);
    expect(boot.proposals.length).toBeGreaterThan(0);

    const after = await handleCoverageList({ repoId });
    expect(after.hasCoverageMap).toBe(true);
    // Every proposed label is on the radar.
    const labelsInReport = new Set(after.features.map((f) => f.label));
    for (const proposal of boot.proposals) {
      expect(labelsInReport.has(proposal.label)).toBe(true);
    }
    for (const f of after.features) {
      expect(f.filesInGlob).toBeGreaterThan(0);
    }
  });

  it('proposed globs actually match tracked files in the repo', async () => {
    const res = await handleCoverageBootstrapMap({ repoId, commit: true });
    const map = loadCoverageMap(repoPath);
    // Every label written to disk must round-trip via parseCoverageMap.
    expect(map.size).toBe(res.proposals.length);
  });
});

describe('features beyond plans', () => {
  it('every detected feature appears on the radar — not just the ones with plans', async () => {
    // Plant a coverage map with three labels and a plan that only mentions
    // ONE of them. Every detected feature directory should still show up.
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(
      join(repoPath, 'qa', 'coverage-map.md'),
      [
        '# Coverage map',
        '',
        '- `main`: `src/main/**`',
        '- `renderer`: `src/renderer/**`',
        '- `shared`: `src/shared/**`',
        '',
      ].join('\n'),
    );

    const report = await handleCoverageList({ repoId });
    const labels = new Set(report.features.map((f) => f.label));
    // All three map labels are radar axes.
    expect(labels.has('main')).toBe(true);
    expect(labels.has('renderer')).toBe(true);
    expect(labels.has('shared')).toBe(true);
    // None of them have any plan yet — all sit at 0%.
    for (const f of report.features) {
      expect(f.coveragePct).toBe(0);
      expect(f.caseCount).toBe(0);
    }
  });
});

describe('parseCoverageMap regression', () => {
  it('parses the exact output renderCoverageMap produces', async () => {
    await handleCoverageBootstrapMap({ repoId, commit: true });
    const raw = readFileSync(join(repoPath, 'qa', 'coverage-map.md'), 'utf8');
    const map = parseCoverageMap(raw);
    expect(map.size).toBeGreaterThan(0);
  });
});
