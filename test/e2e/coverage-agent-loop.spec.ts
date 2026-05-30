import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * End-to-end of the autonomous Coverage Agent, driven entirely through the UI
 * (no DB seeding of plans, no backend-state shortcuts):
 *
 *   1. Happy path — one click of "Run coverage pass" turns the dark
 *      `wealthlab` feature into one with an auto-drafted plan, the agent card
 *      reports completion, and the drafted plan opens in the editor via the
 *      per-feature deep-link.
 *   2. Cancel — a slow pass can be stopped mid-flight from the card.
 *
 * The stub `claude` emits a parseable test plan, so generation writes a real
 * plan file; the hunt run then completes (a clean read-only run is success).
 */

const PLAN_OUTPUT = `BEGIN_TEST_PLAN
{
  "blocks": [
    { "kind": "section", "title": "Smoke" },
    { "kind": "case", "title": "Boots without errors", "expected": "Renders", "repro": "Open app", "severity": "P0", "scope": ["wealthlab"] }
  ]
}
END_TEST_PLAN`;

/** A stub `claude` that emits a plan. `sleepSeconds` slows generation so a
 *  test has a window to observe / cancel the in-flight pass. */
function stubClaude(sleepSeconds = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-stub-covloop-'));
  const stub = join(dir, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  --version) echo "claude 0.0.0-stub"; exit 0 ;;
esac
${sleepSeconds > 0 ? `sleep ${sleepSeconds}` : ''}
cat <<'EOF'
${PLAN_OUTPUT}
EOF
exit 0
`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  return dir;
}

function seedCodeFiles(repoDir: string): void {
  for (const f of ['src/wealthlab/auth.ts', 'src/wealthlab/charts.ts', 'src/main/index.ts']) {
    const full = join(repoDir, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  mkdirSync(join(repoDir, 'qa'), { recursive: true });
  writeFileSync(
    join(repoDir, 'qa', 'coverage-map.md'),
    '# Coverage map\n\n- `wealthlab`: `src/wealthlab/**`\n',
  );
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -q -m "seed"', { cwd: repoDir });
}

async function openCoverage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await expect(page.getByTestId('coverage-agent-card')).toBeVisible({ timeout: 15_000 });
}

let ctx: LaunchedApp;
let stubDir: string | null = null;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = null;
});

test('Run coverage pass auto-drafts a plan for a dark feature, hunts it, and the plan opens in the editor', async () => {
  stubDir = stubClaude();
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await openCoverage(page);

  // The wealthlab feature starts dark — its card offers "Generate test plan",
  // i.e. no plan exists yet.
  await expect(page.getByTestId('feature-card-generate-wealthlab')).toBeVisible({
    timeout: 15_000,
  });

  // One click kicks off the whole autonomous pass.
  const runBtn = page.getByTestId('coverage-agent-run');
  await expect(runBtn).toBeEnabled({ timeout: 15_000 });
  await runBtn.click();

  // The phase strip + a live status line appear once the pass starts.
  await expect(page.getByTestId('coverage-agent-phases')).toBeVisible();
  await expect(page.getByTestId('coverage-agent-status')).toBeVisible({ timeout: 15_000 });

  // USER-VISIBLE OUTCOME #1: the dark feature now has an auto-drafted plan —
  // its card shows a Bug Hunter run row instead of the Generate button.
  await expect(page.locator('[data-testid^="feature-card-run-wealthlab-qa-hunter-"]')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId('feature-card-generate-wealthlab')).toHaveCount(0);

  // USER-VISIBLE OUTCOME #2: the agent card reports the pass finished and the
  // Run button is offered again (no longer active).
  await expect(page.getByTestId('coverage-agent-status')).toContainText('Pass complete', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('coverage-agent-run')).toBeVisible();

  // USER-VISIBLE OUTCOME #3: the drafted plan opens in the editor via the
  // per-feature deep-link (Test Plans is no longer a sidebar tab).
  await page.locator('[data-testid^="feature-card-edit-wealthlab-"]').first().click();
  await expect(page.locator('.test-plans-toc-section', { hasText: 'Smoke' })).toBeVisible({
    timeout: 15_000,
  });
});

test('A running coverage pass can be cancelled from the card', async () => {
  // A slow stub keeps the pass in its drafting stage long enough to cancel.
  stubDir = stubClaude(6);
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await openCoverage(page);

  await page.getByTestId('coverage-agent-run').click();

  // While the pass works, the card offers a Stop button — click it.
  const stopBtn = page.getByTestId('coverage-agent-cancel');
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await stopBtn.click();

  // The pass winds down to a cancelled state (after the in-flight spawn
  // returns) and the Run button comes back.
  await expect(page.getByTestId('coverage-agent-status')).toContainText('Cancelled', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('coverage-agent-run')).toBeVisible();
});
