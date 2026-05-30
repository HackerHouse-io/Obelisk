import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * The Coverage screen is feature-dense, so a first-run guided tour explains it.
 * It auto-shows the first time, never nags again (persisted), and is always
 * replayable from the header ? button.
 */

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Coverage tour auto-shows on first visit, persists dismissal, and replays from the ? button', async () => {
  // freshTour = run as a brand-new user so the auto-show fires.
  ctx = await launchApp({ seedFixtures: { mode: 'observe', agents: ['qa-hunter'] }, freshTour: true });
  const page = ctx.window;

  await page.getByRole('button', { name: 'Coverage', exact: true }).click();

  // 1. Auto-shows on first visit, starting at the welcome step.
  const tour = page.getByTestId('coverage-tour');
  await expect(tour).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('coverage-tour-card')).toContainText('Welcome to Coverage');

  // 2. Step through to the end; "Got it" dismisses it.
  for (let i = 0; i < 8; i++) {
    if (!(await tour.isVisible())) break;
    await page.getByTestId('coverage-tour-next').click();
  }
  await expect(tour).toBeHidden();

  // 3. Navigating away and back does NOT re-show it (dismissal persisted).
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await expect(page.getByTestId('coverage-agent-card')).toBeVisible({ timeout: 15_000 });
  await expect(tour).toBeHidden();

  // 4. The ? button replays the tour on demand.
  await page.getByTestId('coverage-tour-replay-btn').click();
  await expect(tour).toBeVisible();

  // 5. Skip closes it immediately.
  await page.getByTestId('coverage-tour-skip').click();
  await expect(tour).toBeHidden();
});
