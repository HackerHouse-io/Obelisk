import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * End-to-end coverage of async plan generation:
 *   - Click Draft → modal closes immediately
 *   - Toast appears with progress
 *   - With a stub `claude` that emits a valid BEGIN_TEST_PLAN block, the
 *     toast advances to "Test plan ready" and the Open button works.
 */

let ctx: LaunchedApp;
let stubBinDir: string;

const STUB_OUTPUT = `BEGIN_TEST_PLAN
{
  "blocks": [
    { "kind": "section", "title": "Smoke" },
    { "kind": "case", "title": "App boots without errors", "expected": "Primary route renders", "repro": "Open app", "severity": "P0" },
    { "kind": "section", "title": "Authentication" },
    { "kind": "case", "title": "Sign in with valid creds", "expected": "Lands on home", "repro": "Submit form", "severity": "P0" },
    { "kind": "case", "title": "Sign in with bad password shows error", "expected": "Inline error", "repro": "Submit wrong pw", "severity": "P1" }
  ]
}
END_TEST_PLAN`;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-plan-'));
  // Stub `claude --version` and the planning invocation: emit our fixture.
  const stubPath = join(stubBinDir, 'claude');
  writeFileSync(
    stubPath,
    `#!/bin/sh
case "$1" in
  --version) echo "claude 0.0.0-stub"; exit 0 ;;
esac
cat <<'EOF'
${STUB_OUTPUT}
EOF
exit 0
`,
    'utf8',
  );
  chmodSync(stubPath, 0o755);
});

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
});

test('Draft plan closes the modal, shows a toast, and produces a real plan via the stub runner', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;

  // Trigger the gate via Run.
  await page.getByTestId('run-qa-hunter').first().click();
  const dialog = page.getByTestId('plan-gate-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('plan-gate-generate-cta').click();
  await page.getByTestId('plan-gate-submit').click();

  // Modal closes immediately — async generation owns the feedback now.
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // Toast appears with in-progress state, then transitions to ready.
  const toast = page.locator('.tpg-toast').first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText('Test plan ready', { timeout: 30_000 });

  // The Open button on the toast jumps to the editor with the new plan.
  await page.getByTestId('tpg-toast-open').click();
  // The editor's Run button confirms we landed on a real plan with cases.
  await expect(page.getByTestId('plan-run-button')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Authentication', { exact: false }).first()).toBeVisible();
});
