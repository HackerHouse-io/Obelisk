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

  // The map on disk now contains the stub's LLM-proposed labels (those that
  // matched real files). Coverage v2 defaults to REPLACE — so the user's
  // existing "custom-keep-me" is GONE unless they opt-in via the checkbox.
  // The hallucinated `auth` label (no src/auth/ in the seed) is also dropped.
  const after = readFileSync(mapPath, 'utf8');
  expect(after).not.toContain('`custom-keep-me`'); // REPLACE wiped it
  expect(after).not.toContain('`auth`'); // hallucinated → dropped
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
  // `auth` is dropped (hallucinated — no src/auth/ in seed); validated
  // labels survive.
  expect(content).not.toContain('`auth`');
  expect(content).toContain('`renderer-screens`');
});

test('Regenerate REPLACE (default) nukes existing labels with the LLM proposals', async () => {
  stubDir = stubClaude();
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant a bloated map with stale + custom labels.
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(
    mapPath,
    '# Coverage map\n\n' +
      '- `old-label-1`: `**/nope/**`\n' +
      '- `old-label-2`: `**/nada/**`\n' +
      '- `legacy-custom`: `src/**`\n',
  );

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-regenerate-btn').click();
  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // "Keep existing labels" checkbox exists, defaults UNCHECKED (= replace).
  const keepExisting = page.getByTestId('coverage-regen-keep-existing');
  await expect(keepExisting).toBeVisible();
  await expect(keepExisting).not.toBeChecked();

  await dialog.getByRole('button', { name: /^Regenerate$/ }).click();

  // Wait for the file to be replaced.
  await expect
    .poll(() => readFileSync(mapPath, 'utf8'), { timeout: 15_000 })
    .not.toContain('old-label-1');

  const after = readFileSync(mapPath, 'utf8');
  // OLD labels are GONE — this is the heart of the fix.
  expect(after).not.toContain('`old-label-1`');
  expect(after).not.toContain('`old-label-2`');
  expect(after).not.toContain('`legacy-custom`');
  // NEW LLM labels (those whose globs match files) are present.
  expect(after).toMatch(/`renderer-screens`/);
  expect(after).toMatch(/`main-agents`/);
});

test('Regenerate KEEP-EXISTING (opt-in via checkbox) merges instead of replacing', async () => {
  stubDir = stubClaude();
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(mapPath, '# Coverage map\n\n- `legacy-custom`: `src/**`\n');

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('coverage-regenerate-btn').click();
  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Check the "Keep existing labels" checkbox.
  await page.getByTestId('coverage-regen-keep-existing').check();
  await dialog.getByRole('button', { name: /^Regenerate$/ }).click();

  // Wait for the new LLM labels to be merged in.
  await expect
    .poll(() => readFileSync(mapPath, 'utf8'), { timeout: 15_000 })
    .toMatch(/`renderer-screens`/);

  const after = readFileSync(mapPath, 'utf8');
  // Existing label preserved (merge mode).
  expect(after).toContain('`legacy-custom`');
  // New LLM labels also present.
  expect(after).toMatch(/`renderer-screens`/);
  expect(after).toMatch(/`main-agents`/);
});

test('Clean stale labels button removes 0-file labels in one click', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant a map with 2 real labels + 3 stale ones.
  const mapPath = join(ctx.repoDir, 'qa', 'coverage-map.md');
  mkdirSync(join(ctx.repoDir, 'qa'), { recursive: true });
  writeFileSync(
    mapPath,
    '# Coverage map\n\n' +
      '- `main`: `src/main/**`\n' +
      '- `renderer`: `src/renderer/**`\n' +
      '- `bogus1`: `**/nope/**`\n' +
      '- `bogus2`: `**/nada/**`\n' +
      '- `bogus3`: `src/totally-fake/**`\n',
  );

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  // The stale-labels diagnostic appears with the clean button.
  const cleanBtn = page.getByTestId('coverage-clean-stale-btn');
  await expect(cleanBtn).toBeVisible({ timeout: 15_000 });
  await cleanBtn.click();

  // Branded confirm dialog appears with the list of labels to remove.
  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toContainText(/Remove 3 broken labels/);
  await dialog.getByRole('button', { name: /Remove labels/ }).click();

  // Wait for the file to be cleaned.
  await expect
    .poll(() => readFileSync(mapPath, 'utf8'), { timeout: 15_000 })
    .not.toContain('bogus1');

  const after = readFileSync(mapPath, 'utf8');
  expect(after).not.toContain('`bogus1`');
  expect(after).not.toContain('`bogus2`');
  expect(after).not.toContain('`bogus3`');
  expect(after).toContain('`main`');
  expect(after).toContain('`renderer`');

  // The diagnostic strip disappears after the load() refresh.
  await expect(page.getByTestId('coverage-stale-labels')).toHaveCount(0, { timeout: 5_000 });
});

test('Expand modal shows a SORTABLE TABLE, not a giant radar', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  // Many features so the table content is interesting.
  for (let i = 0; i < 14; i++) {
    const dir = join(ctx.repoDir, 'src', `feat${i}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "many features"', { cwd: ctx.repoDir });

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await expect(page.locator('.coverage-feature-card-label').first()).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId('coverage-radar-expand').click();
  // The new TABLE is mounted, not a radar.
  await expect(page.getByTestId('coverage-features-table')).toBeVisible({ timeout: 5_000 });
  // The modal-body does NOT contain a radar svg.
  const modalRadarCount = await page
    .locator('.coverage-table-modal-body svg.coverage-radar')
    .count();
  expect(modalRadarCount).toBe(0);

  // The action for a plan-less feature is explicit, not a cryptic "Plan".
  const genBtn = page.locator('[data-testid^="coverage-table-generate-"]').first();
  await expect(genBtn).toContainText('Generate test plan');

  // Sort by Coverage % — already default. Click "Feature" header to sort alphabetically.
  await page.getByTestId('coverage-table-sort-name').click();
  // First visible row label should be alphabetically earliest among feat0..feat13.
  const firstRowName = await page
    .locator('.coverage-features-cell-name')
    .first()
    .innerText();
  expect(firstRowName.toLowerCase()).toMatch(/^feat\d+$/);

  // Click a row — modal closes and that feature is selected on the main view.
  const targetLabel = firstRowName.toLowerCase();
  await page.getByTestId(`coverage-table-row-${targetLabel}`).click();
  await expect(page.getByTestId('coverage-radar-modal')).toHaveCount(0, { timeout: 5_000 });
  // The card for that label is now in the .selected state on the main view.
  const selectedCardLabel = await page
    .locator('.coverage-feature-card.selected .coverage-feature-card-label')
    .first()
    .innerText();
  expect(selectedCardLabel.toLowerCase()).toBe(targetLabel);
});

test('Inline radar caps at 8 axes', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  for (let i = 0; i < 14; i++) {
    const dir = join(ctx.repoDir, 'src', `feat${i}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "many features"', { cwd: ctx.repoDir });

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const stage = page.locator('.coverage-radar-stage');
  await expect(stage.locator('.coverage-radar-label-text').first()).toBeVisible({
    timeout: 15_000,
  });
  const axisCount = await stage.locator('.coverage-radar-label-text').count();
  expect(axisCount).toBeLessThanOrEqual(8);
});

// Legacy test renamed for clarity; kept around to prevent regressions in
// the heuristic fallback path (no Claude CLI installed).
test('Heuristic fallback (no CLI): regenerate still works without Claude', async () => {
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

  // 4) A success toast appears (never "removed N labels"). The text is one of:
  //    • "Added N new labels"     — when scanner found labels not already in features
  //    • "Map already up to date" — when the map already includes every discovered label
  //    Either is correct; the load-bearing fact is that no destructive toast appears.
  await expect(
    page.getByText(/Added \d+ new label|Map already up to date/),
  ).toBeVisible({ timeout: 5_000 });
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

test('Visual screenshot of sortable table modal at 30 features', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  for (let i = 0; i < 14; i++) {
    const dir = join(ctx.repoDir, 'src', `feat${i}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "many features"', { cwd: ctx.repoDir });
  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await expect(page.locator('.coverage-feature-card-label').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId('coverage-radar-expand').click();
  await expect(page.getByTestId('coverage-features-table')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(400);
  await page
    .locator('.coverage-radar-modal')
    .screenshot({ path: '/tmp/obelisk-table-modal.png' });
});

test('Radar layout screenshot — visual proof of no overlap/clipping', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  for (let i = 0; i < 15; i++) {
    const dir = join(ctx.repoDir, 'src', `feat${i}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "many features"', { cwd: ctx.repoDir });
  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const stage = page.locator('.coverage-radar-stage').first();
  await expect(stage).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800); // let the radar tween settle
  await stage.screenshot({ path: '/tmp/obelisk-radar-layout.png' });
});

test('Radar layout: overflow note sits BELOW the radar, labels are not clipped', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;

  // 15 feature dirs → radar shows 10, overflow text shows "+5 more".
  for (let i = 0; i < 15; i++) {
    const dir = join(ctx.repoDir, 'src', `feat${i}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), '// seed\n');
  }
  execSync('git add . && git commit -q -m "many features"', { cwd: ctx.repoDir });

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const stage = page.locator('.coverage-radar-stage').first();
  await expect(stage).toBeVisible({ timeout: 15_000 });

  // 1) The overflow note is BELOW the radar SVG, not beside it.
  const svgBox = await stage.locator('svg.coverage-radar').boundingBox();
  const overflowBox = await stage.locator('.coverage-radar-overflow').boundingBox();
  expect(svgBox).not.toBeNull();
  expect(overflowBox).not.toBeNull();
  // Overflow note top must be at or below the SVG bottom (allow 4px slop).
  expect(overflowBox!.y + 2).toBeGreaterThanOrEqual(svgBox!.y + svgBox!.height - 4);
  // Overflow note text takes a single visual line: height < 30px (no
  // letter-by-letter wrapping like the broken screenshot showed).
  expect(overflowBox!.height).toBeLessThan(30);

  // 2) Every radar axis label text fits inside the stage's bounding box —
  //    proves nothing is being clipped at the SVG edge.
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const labels = stage.locator('.coverage-radar-label-text');
  const labelCount = await labels.count();
  expect(labelCount).toBeGreaterThan(0);
  for (let i = 0; i < labelCount; i++) {
    const lbl = await labels.nth(i).boundingBox();
    if (!lbl) continue;
    expect(lbl.x).toBeGreaterThanOrEqual(stageBox!.x - 1);
    expect(lbl.x + lbl.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1);
  }
});

// Note: Coverage v2 replaced the "expand modal = bigger radar" UX with a
// sortable table — see the `Expand modal shows a SORTABLE TABLE` test
// earlier in this file. The inline 8-axis cap is exercised by `Inline
// radar caps at 8 axes` above.

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
