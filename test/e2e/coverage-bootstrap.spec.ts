import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

const STUB_COVERAGE_MAP_OUTPUT = `BEGIN_COVERAGE_MAP
{
  "features": [
    { "label": "auth", "globs": ["src/auth/**"] },
    { "label": "renderer-screens", "globs": ["src/renderer/screens/**"] },
    { "label": "main-agents", "globs": ["src/main/agents/**"] },
    { "label": "main-ipc", "globs": ["src/main/ipc/**"] },
    { "label": "shared-types", "globs": ["src/shared/**"] }
  ]
}
END_COVERAGE_MAP`;

function stubClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-stub-cov-'));
  const stub = join(dir, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  --version) echo "claude 0.0.0-stub"; exit 0 ;;
esac
cat <<'EOF'
${STUB_COVERAGE_MAP_OUTPUT}
EOF
exit 0
`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  return dir;
}

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
let stubDir: string | null = null;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = null;
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

  await page.getByTestId('coverage-bootstrap-btn').click();

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

test('Regenerate spawns Claude CLI, writes LLM-proposed labels, shows progress, refreshes radar', async () => {
  stubDir = stubClaude();
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant an existing map with a custom label that MUST survive the regen.
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(mapPath, '# Coverage map\n\n- `custom-keep-me`: `src/**`\n');

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-regenerate-btn').click();
  // Branded confirm dialog.
  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: /^Regenerate$/ }).click();

  // Progress card appears with the running stage.
  const progress = page.getByTestId('coverage-gen-progress');
  await expect(progress).toBeVisible({ timeout: 5_000 });

  // Job reaches "done" stage (stub returns immediately).
  await expect(progress).toHaveAttribute('data-stage', 'done', { timeout: 30_000 });

  // The map on disk now contains the stub's LLM-proposed labels AND the
  // user-customised "custom-keep-me" label (merged, not destroyed).
  const after = readFileSync(mapPath, 'utf8');
  expect(after).toContain('`custom-keep-me`');
  expect(after).toContain('`auth`');
  expect(after).toContain('`renderer-screens`');
  expect(after).toContain('`main-agents`');
  expect(after).toContain('`main-ipc`');
  expect(after).toContain('`shared-types`');

  // Toast confirms what was added.
  await expect(page.getByText(/Added \d+ new label/)).toBeVisible({ timeout: 5_000 });

  // Radar reflects the new labels (only those with matching tracked files —
  // `auth` has no src/auth in the seed so it's stale; the rest are visible).
  const cards = page.locator('.coverage-feature-card-label');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const labels = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());
  expect(labels).toContain('main-agents');
  expect(labels).toContain('main-ipc');
});

test('Bootstrap (no map yet) uses Claude CLI when it is installed', async () => {
  stubDir = stubClaude();
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  // The banner now reads "Generate coverage map" (LLM-driven), not "Bootstrap".
  const genBtn = page.getByTestId('coverage-bootstrap-btn');
  await expect(genBtn).toBeVisible({ timeout: 10_000 });
  await expect(genBtn).toContainText(/Generate coverage map/i);
  await genBtn.click();

  // Progress card streams through stages and reaches done.
  const progress = page.getByTestId('coverage-gen-progress');
  await expect(progress).toBeVisible({ timeout: 5_000 });
  await expect(progress).toHaveAttribute('data-stage', 'done', { timeout: 30_000 });

  // qa/coverage-map.md exists with the stub's labels.
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  expect(existsSync(mapPath)).toBe(true);
  const content = readFileSync(mapPath, 'utf8');
  expect(content).toContain('`auth`');
  expect(content).toContain('`renderer-screens`');
});

test('Regenerate map MERGES: preserves existing user labels AND adds new scanner labels', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant a hand-edited map with custom labels (`wealthlab`, `lessons`)
  // that the SCANNER WOULD NOT FIND because there's no src/wealthlab/ or
  // src/lessons/ in the seed. They're plan-only / user-only labels and
  // regenerate must preserve them.
  const mapDir = join(ctx.repoDir, 'qa');
  const mapPath = join(mapDir, 'coverage-map.md');
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(
    mapPath,
    '# Coverage map\n\n' +
      '- `wealthlab`: `**/wealthlab/**`\n' +
      '- `lessons`: `**/lessons/**`\n' +
      '- `main`: `src/main/ipc/**`\n', // user customised the main glob
  );

  let nativeDialogSeen = false;
  ctx.app.on('window', (w) => {
    w.on('dialog', () => {
      nativeDialogSeen = true;
    });
  });

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-regenerate-btn').click();

  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: /^Regenerate$/ }).click();

  // Wait for the file to be rewritten.
  await expect
    .poll(
      () => {
        const txt = readFileSync(mapPath, 'utf8');
        // The scanner adds `renderer` etc — wait until the file has more
        // labels than we planted.
        const labelLines = txt.split('\n').filter((l) => /^-\s+`/.test(l));
        return labelLines.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(3);

  const after = readFileSync(mapPath, 'utf8');

  // 1) USER LABELS PRESERVED — the heart of the merge bug.
  expect(after).toContain('`wealthlab`');
  expect(after).toContain('`lessons`');

  // 2) USER-CUSTOMISED GLOB PRESERVED — the scanner would have written
  //    `src/main/**` but the user's `src/main/ipc/**` must win.
  expect(after).toContain('`main`: `src/main/ipc/**`');
  expect(after).not.toContain('`main`: `src/main/**`');

  // 3) NEW SCANNER LABELS ADDED.
  expect(after).toMatch(/`renderer`/);
  expect(after).toMatch(/`shared`/);

  // 4) Success toast appears showing what was ADDED — never "removed N".
  await expect(page.getByText(/Added \d+ new labels?/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/removed \d+ label/)).toHaveCount(0);

  // 5) Banner doesn't reappear, no error alert, no native dialog.
  await expect(page.getByText('Coverage map already exists')).toHaveCount(0);
  expect(nativeDialogSeen).toBe(false);

  // 6) Radar reflects the scanner-added labels (the user's wealthlab/lessons
  //    don't have matching dirs in this fixture so they're stale — that's
  //    correct behavior, just not what we assert here).
  const cards = page.locator('.coverage-feature-card-label');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const labels = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());
  expect(labels).toContain('main');
  expect(labels).toContain('renderer');
});

test('Regenerate adds a brand-new feature dir to the existing map', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Initial map with the labels the scanner would find on seed (main, renderer, shared).
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(
    mapPath,
    '# Coverage map\n\n- `main`: `src/main/**`\n- `renderer`: `src/renderer/**`\n- `shared`: `src/shared/**`\n',
  );

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  // Count features BEFORE.
  const cards = page.locator('.coverage-feature-card-label');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const before = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());

  // User adds a brand-new feature directory after the initial bootstrap.
  const newFeatureDir = join(ctx.repoDir, 'src', 'analytics');
  mkdirSync(newFeatureDir, { recursive: true });
  for (const f of ['index.ts', 'collector.ts', 'reporter.ts']) {
    writeFileSync(join(newFeatureDir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "add analytics feature"', { cwd: ctx.repoDir });

  // Regenerate.
  await page.getByTestId('coverage-regenerate-btn').click();
  await page.locator('[role="alertdialog"]').getByRole('button', { name: /^Regenerate$/ }).click();

  // Toast confirms the new label was added.
  await expect(page.getByText(/Added 1 new label/)).toBeVisible({ timeout: 5_000 });

  // File on disk contains BOTH old and new labels.
  const after = readFileSync(mapPath, 'utf8');
  expect(after).toContain('`main`');
  expect(after).toContain('`renderer`');
  expect(after).toContain('`shared`');
  expect(after).toContain('`analytics`');

  // Radar now has analytics in addition to everything before.
  // (Use poll because the toast + load() are async.)
  await expect
    .poll(
      async () => {
        const labels = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());
        return labels.includes('analytics');
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  const finalLabels = (await cards.allInnerTexts()).map((s) => s.trim().toLowerCase());
  for (const old of before) expect(finalLabels).toContain(old);
});

test('Regenerate on an up-to-date map shows "already up to date" toast', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // First bootstrap (initial), then regenerate immediately — nothing changed.
  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-bootstrap-btn').click();
  await expect(page.getByTestId('coverage-regenerate-btn')).toBeVisible({ timeout: 10_000 });
  // Dismiss the "Wrote..." toast.
  const wroteOk = page.getByRole('button', { name: 'OK' });
  if (await wroteOk.count()) await wroteOk.click();

  await page.getByTestId('coverage-regenerate-btn').click();
  await page.locator('[role="alertdialog"]').getByRole('button', { name: /^Regenerate$/ }).click();

  await expect(page.getByText(/Map already up to date/i)).toBeVisible({ timeout: 5_000 });
});

test('Regenerate cancel keeps the existing map intact', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(mapPath, '# Coverage map\n\n- `keep-me`: `src/**`\n');

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-regenerate-btn').click();

  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // File untouched.
  expect(readFileSync(mapPath, 'utf8')).toContain('`keep-me`');
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

  await page.getByTestId('coverage-bootstrap-btn').click();

  // Banner disappears (hasCoverageMap flips true) and features appear.
  await expect(banner).toBeHidden({ timeout: 15_000 });
  const labels = page.locator('.coverage-feature-card-label');
  await expect(labels.first()).toBeVisible({ timeout: 10_000 });

  // The stub was overwritten with real content.
  const fresh = readFileSync(join(mapDir, 'coverage-map.md'), 'utf8');
  expect(fresh).not.toContain('old stub');
  expect(fresh).toMatch(/`[\w-]+`:\s*`[^`]+`/);
});
