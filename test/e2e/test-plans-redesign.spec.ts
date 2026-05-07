import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Sidebar QA Playbook entry is gone; Test Plans is the surface', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;

  // The retired QA Playbook nav link should not exist.
  await expect(page.getByRole('button', { name: /^QA Playbook$/ })).toHaveCount(0);
  // Test Plans is reachable.
  await expect(page.getByRole('button', { name: 'Test Plans', exact: true })).toBeVisible();
});

test('Plans empty state renders the onboarding CTA when no plans exist', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;

  await page.getByRole('button', { name: 'Test Plans', exact: true }).click();
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
  await page.getByRole('button', { name: 'Test Plans', exact: true }).click();

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
  await page.getByRole('button', { name: 'Test Plans', exact: true }).click();

  // The seed produces one section "Smoke" — it should appear in the TOC.
  await expect(page.locator('.test-plans-toc-section', { hasText: 'Smoke' })).toBeVisible();
});
