import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

/**
 * Test Plans is no longer a top-level sidebar tab — the editor is reached
 * from inside Coverage via the "Plans" header button.
 */
async function openTestPlans(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await page.getByTestId('coverage-open-plans-btn').click();
}

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Test Plans is no longer a sidebar tab; reachable from Coverage', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;

  // The retired QA Playbook nav link should not exist.
  await expect(page.getByRole('button', { name: /^QA Playbook$/ })).toHaveCount(0);
  // Test Plans is no longer a top-level sidebar destination.
  await expect(page.getByRole('button', { name: 'Test Plans', exact: true })).toHaveCount(0);
  // …but the editor is reachable from inside Coverage.
  await openTestPlans(page);
  await expect(page.getByText('Draft a test plan to start')).toBeVisible();
});

test('Plans empty state renders the onboarding CTA when no plans exist', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;

  await openTestPlans(page);
  await expect(page.getByText('Draft a test plan to start')).toBeVisible();
  await expect(page.getByTestId('plan-empty-cta')).toBeVisible();
});

test('Hero Run button shows the case count', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter', cases: 3 }],
    },
  });
  const page = ctx.window;
  await openTestPlans(page);

  const runButton = page.getByTestId('plan-run-button');
  await expect(runButton).toBeVisible();
  await expect(runButton).toContainText('Run QA Hunter');
  await expect(runButton).toContainText('3 cases');
});

test('Sidebar TOC lists each section of the active plan', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter' }],
    },
  });
  const page = ctx.window;
  await openTestPlans(page);

  // The seed produces one section "Smoke" — it should appear in the TOC.
  await expect(page.locator('.test-plans-toc-section', { hasText: 'Smoke' })).toBeVisible();
});
