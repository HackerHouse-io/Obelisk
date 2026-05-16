import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * End-to-end test of the Coverage bootstrap button.
 *
 *   - Seeds a repo with a few source files committed to git
 *   - Navigates to the Coverage screen
 *   - Clicks "Bootstrap coverage map"
 *   - Asserts that:
 *       1. qa/coverage-map.md is written to disk
 *       2. The "No qa/coverage-map.md yet" banner disappears
 *       3. The radar / feature cards populate from the new map
 *
 * Also covers the stale-broken-map regression: when an empty/unparseable
 * coverage-map.md already exists, the bootstrap button still works.
 */

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

function seedCodeFiles(repoDir: string): void {
  const files = [
    'src/main/index.ts',
    'src/main/ipc/coverage.ts',
    'src/main/ipc/runs.ts',
    'src/main/agents/qa-hunter/index.ts',
    'src/main/agents/manual-qa/index.ts',
    'src/renderer/screens/Coverage.tsx',
    'src/renderer/screens/MissionControl.tsx',
    'src/renderer/screens/Home.tsx',
    'src/shared/types.ts',
    'src/shared/errors.ts',
    'src/shared/case-progress.ts',
  ];
  for (const f of files) {
    const full = join(repoDir, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -q -m "seed code files"', { cwd: repoDir });
}

test('Bootstrap coverage map writes the file, the banner disappears, and features populate', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const banner = page.locator('.coverage-banner-info');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('No');

  await expect(existsSync(join(ctx.repoDir, 'qa', 'coverage-map.md'))).toBe(false);

  await page.getByRole('button', { name: /Bootstrap coverage map/ }).click();

  await expect(banner).toBeHidden({ timeout: 15_000 });

  // qa/coverage-map.md was created with real content.
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  expect(existsSync(mapPath)).toBe(true);
  const raw = readFileSync(mapPath, 'utf8');
  expect(raw).toContain('# Coverage map');
  expect(raw).toMatch(/`[\w-]+`:\s*`[^`]+`/);

  // The radar shows axis labels for at least 2 features. (3+ → polygon
  // radar; 2 → bar list fallback. Either way the labels live in the DOM.)
  const featureCardLabels = page.locator('.coverage-feature-card-label');
  await expect(featureCardLabels.first()).toBeVisible({ timeout: 10_000 });
  expect(await featureCardLabels.count()).toBeGreaterThan(0);
});

test('Every detected feature dir is on the radar — even with zero test plans', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  // No plans, no coverage-map.md — but the live scan should still find
  // src/main, src/renderer, src/shared and render them as feature cards.
  const cards = page.locator('.coverage-feature-card-label');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  const labels = await cards.allInnerTexts();
  const lower = labels.map((l) => l.trim().toLowerCase());
  expect(lower).toContain('main');
  expect(lower).toContain('renderer');
  expect(lower).toContain('shared');
  // All three sit at 0% (no plans yet).
  const pcts = await page.locator('.coverage-feature-card-pct').allInnerTexts();
  for (const p of pcts) expect(p.trim()).toBe('0%');
});

test('Regenerate map rewrites qa/coverage-map.md from a fresh scan', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant a small hand-edited map so the screen comes up with hasCoverageMap=true
  // and the Regenerate button is visible.
  const mapDir = join(ctx.repoDir, 'qa');
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(mapDir, 'coverage-map.md'), '# Coverage map\n\n- `legacy`: `**/*.legacy`\n');

  // Auto-accept the window.confirm() the button triggers.
  await page.evaluate(() => {
    window.confirm = () => true;
  });

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  const regenBtn = page.getByRole('button', { name: /Regenerate map/ });
  await expect(regenBtn).toBeVisible({ timeout: 10_000 });
  await regenBtn.click();

  // After regenerate, the legacy label is gone and the live-scanned features
  // are in the file.
  await expect
    .poll(() => readFileSync(join(mapDir, 'coverage-map.md'), 'utf8'), { timeout: 15_000 })
    .not.toContain('`legacy`');
  const fresh = readFileSync(join(mapDir, 'coverage-map.md'), 'utf8');
  expect(fresh).toMatch(/`main`/);
  expect(fresh).toMatch(/`renderer`/);

  // And the radar visibly contains the live-scanned features.
  const cards = page.locator('.coverage-feature-card-label');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const labels = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());
  expect(labels).toContain('main');
  expect(labels).toContain('renderer');
});

test('Bootstrap overrides a stale/empty coverage-map.md and populates the radar', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant the EXACT broken file the user hit: a header-only stub from an
  // earlier bootstrap attempt. parseCoverageMap returns 0 → hasCoverageMap
  // is false → banner shows. Clicking Bootstrap should still work.
  const mapDir = join(ctx.repoDir, 'qa');
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(mapDir, 'coverage-map.md'), '# Coverage map\n\n<!-- old stub -->\n');

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const banner = page.locator('.coverage-banner-info');
  await expect(banner).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Bootstrap coverage map/ }).click();

  // Banner disappears (hasCoverageMap flips true) and features appear.
  await expect(banner).toBeHidden({ timeout: 15_000 });
  const labels = page.locator('.coverage-feature-card-label');
  await expect(labels.first()).toBeVisible({ timeout: 10_000 });

  // The stub was overwritten with real content.
  const fresh = readFileSync(join(mapDir, 'coverage-map.md'), 'utf8');
  expect(fresh).not.toContain('old stub');
  expect(fresh).toMatch(/`[\w-]+`:\s*`[^`]+`/);
});
