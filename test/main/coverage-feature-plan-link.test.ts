import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createPlan } from '../../src/main/test-plans/store';
import { buildCoverageReport } from '../../src/main/coverage/aggregate';

/**
 * The exact bug the user is hitting: clicking "Generate test plan" on a
 * feature card writes a plan with `frontmatter.feature = '<label>'`, but
 * the card stays on the Generate button. That means `feature.planRefs`
 * is empty in the rebuilt coverage report.
 *
 * The aggregator must associate every feature-scoped plan with its
 * `frontmatter.feature` label so the card flips to the agent buttons,
 * regardless of what scope tags the LLM put on individual cases.
 */

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-feature-plan-link-'));
  repoPath = join(tmp, 'repo');
  mkdirSync(repoPath, { recursive: true });

  // A repo with a wealthlab directory so the label has matching files.
  for (const f of [
    'src/wealthlab/index.ts',
    'src/wealthlab/charts.ts',
    'src/wealthlab/data.ts',
  ]) {
    const full = join(repoPath, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  mkdirSync(join(repoPath, 'qa'), { recursive: true });
  writeFileSync(
    join(repoPath, 'qa', 'coverage-map.md'),
    '# Coverage map\n\n- `wealthlab`: `src/wealthlab/**`\n',
  );

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.add('.');
  await git.commit('initial');

  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/wealthlab',
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

describe('feature-scoped plan → feature card linkage', () => {
  it("populates feature.planRefs from frontmatter.feature even when cases tag a DIFFERENT scope", async () => {
    // This mirrors what the user hit: the LLM tagged cases with ["smoke"]
    // (not ["wealthlab"]) but the plan's frontmatter.feature is "wealthlab".
    // The wealthlab card MUST still flip to "hasPlan".
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'wealthlab',
      generatedBy: 'claude',
      blocks: [
        { kind: 'section', id: 's1', title: 'Smoke' },
        {
          kind: 'case',
          id: 'c1',
          title: 'Boots without errors',
          expected: 'Renders',
          repro: 'Open',
          severity: 'P0',
          scope: ['smoke'], // ← intentionally NOT 'wealthlab'
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    expect(wealthlab).toBeTruthy();
    expect(wealthlab!.planRefs.length).toBeGreaterThan(0);
    expect(wealthlab!.planRefs[0]!.name).toContain('Wealthlab');
    // The agent buttons render when planRefs include qa-hunter.
    expect(wealthlab!.planRefs[0]!.agentNames).toContain('qa-hunter');
  });

  it('also handles a plan whose cases have NO scope tags at all', async () => {
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'wealthlab',
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'No scope set',
          expected: 'Renders',
          repro: 'Open',
          severity: 'P0',
          scope: null, // ← no scope at all
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    expect(wealthlab).toBeTruthy();
    expect(wealthlab!.planRefs.length).toBeGreaterThan(0);
  });

  it('matches case-insensitively (featureName "Wealthlab" still binds to label "wealthlab")', async () => {
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'Wealthlab', // ← capitalised
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'Capitalised feature',
          expected: 'ok',
          repro: 'ok',
          severity: 'P0',
          scope: null,
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    expect(wealthlab).toBeTruthy();
    expect(wealthlab!.planRefs.length).toBeGreaterThan(0);
  });

  it('whole-app plans do NOT pollute every feature with planRefs', async () => {
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'Smoke',
          expected: 'ok',
          repro: 'ok',
          severity: 'P0',
          scope: ['smoke'],
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    if (wealthlab) {
      // wealthlab might exist (it's in the map) but shouldn't have plan refs
      // from a whole-app plan that didn't tag it.
      expect(wealthlab.planRefs.length).toBe(0);
    }
  });

  it('whole-app plans land in report.wholeAppPlans, not on feature cards — even when their cases tag a feature label', async () => {
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'Wealthlab probe (case tagged the feature)',
          expected: 'ok',
          repro: 'ok',
          severity: 'P0',
          // A per-case scope tag pointing at a feature must NOT cause the
          // owning whole-app plan to attach to that feature card.
          scope: ['wealthlab'],
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    expect(report.wholeAppPlans.length).toBe(1);
    expect(report.wholeAppPlans[0]!.agentNames).toContain('qa-hunter');

    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    // wealthlab still surfaces (the map references it) but no plan attaches.
    expect(wealthlab?.planRefs ?? []).toEqual([]);
  });

  it("scope-tag-only labels (not in coverage-map.md) are NOT reported as staleLabels", async () => {
    // Regression: a whole-app plan whose cases tag labels like 'appstate',
    // 'assets', etc. used to produce 30+ "broken labels" the user couldn't
    // remove — the cleanup CTA only edits coverage-map.md, but those
    // labels were never written there. The aggregator must only flag a
    // label as stale when the user can actually act on it.
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'Tagged with labels not in the map',
          expected: 'ok',
          repro: 'ok',
          severity: 'P0',
          scope: ['appstate', 'assets', 'gestures'],
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    for (const tag of ['appstate', 'assets', 'gestures']) {
      expect(report.staleLabels).not.toContain(tag);
    }
  });

  it('feature-scoped plans do NOT appear in report.wholeAppPlans', async () => {
    createPlan({
      repoPath,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'wealthlab',
      generatedBy: 'claude',
      blocks: [
        {
          kind: 'case',
          id: 'c1',
          title: 'Feature-scoped only',
          expected: 'ok',
          repro: 'ok',
          severity: 'P0',
          scope: null,
        },
      ],
    });

    const report = await buildCoverageReport(repoId);
    expect(report.wholeAppPlans).toEqual([]);
    const wealthlab = report.features.find((f) => f.label === 'wealthlab');
    expect(wealthlab!.planRefs.length).toBe(1);
  });
});
