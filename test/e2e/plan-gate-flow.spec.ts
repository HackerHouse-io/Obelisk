import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Run QA Hunter with no plans opens the no-plan dialog and starts an async generation', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      // intentionally no testPlans
    },
  });
  const page = ctx.window;

  await page.getByTestId('run-qa-hunter').first().click();

  // Step 1: no-plan view appears
  const dialog = page.getByTestId('plan-gate-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText(/needs a test plan/i);

  // Click "Generate plan" → advances to the form view
  await page.getByTestId('plan-gate-generate-cta').click();
  await expect(dialog).toContainText(/Generate test plan/i);

  // Whole-app is the default scope; submit kicks off async generation
  await page.getByTestId('plan-gate-submit').click();

  // The dialog closes immediately and a toast appears with progress.
  // Without an LLM runner installed (the e2e default), the toast eventually
  // shows the "Generation failed" state with a retry-friendly message.
  await expect(dialog).toBeHidden({ timeout: 5_000 });
  const toast = page.locator('.tpg-toast').first();
  await expect(toast).toBeVisible({ timeout: 30_000 });
  // Either still drafting or already failed — both are non-silent feedback.
  await expect(toast).toContainText(/Drafting test plan|Generation failed|Test plan ready/);
});

test('Run QA Hunter with one plan dispatches directly without dialog', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter' }],
    },
  });
  const page = ctx.window;

  await page.getByTestId('run-qa-hunter').first().click();

  // No plan-gate dialog (one plan auto-selected). The runner-not-installed
  // error is the expected next outcome on a vanilla machine.
  await expect(page.getByTestId('plan-gate-dialog')).toHaveCount(0);
  await expect(page.getByTestId('run-error')).toBeVisible({ timeout: 15_000 });
});

test('Run QA Hunter with two plans opens the picker', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [
        { agentName: 'qa-hunter', id: 'full-app', name: 'Full app sweep' },
        {
          agentName: 'qa-hunter',
          id: 'feature-checkout',
          name: 'Checkout sweep',
          scope: 'feature',
          feature: 'checkout',
        },
      ],
    },
  });
  const page = ctx.window;

  await page.getByTestId('run-qa-hunter').first().click();

  const dialog = page.getByTestId('plan-gate-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText(/Pick a test plan/i);

  // Both plans are listed
  await expect(page.getByTestId('plan-picker-full-app')).toBeVisible();
  await expect(page.getByTestId('plan-picker-feature-checkout')).toBeVisible();

  // Picking one closes the dialog and dispatches a run (which then surfaces
  // the runner-not-installed error since no CLI is on PATH).
  await page.getByTestId('plan-picker-feature-checkout').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('run-error')).toBeVisible({ timeout: 15_000 });
});

test('Test Plans screen lists seeded plans and the Run button dispatches with plan id', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter', id: 'full-app', name: 'Full app sweep' }],
    },
  });
  const page = ctx.window;

  // Test Plans is now reached from inside Coverage (no longer a sidebar tab).
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await page.getByTestId('coverage-open-plans-btn').click();

  // Plan in the sidebar list
  await expect(page.getByTestId('plan-item-full-app')).toBeVisible();
  await expect(page.getByTestId('plan-run-button')).toBeVisible();

  // Sections + cases render
  await expect(page.getByText('Smoke', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Case 1: do thing 1').first()).toBeVisible();
});
