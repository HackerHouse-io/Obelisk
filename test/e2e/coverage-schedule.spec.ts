import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * The Coverage Agent can run on a schedule, like any other agent. This drives
 * the enable toggle + cron picker in the Coverage Agent card and asserts the
 * choice persists through the backend (`coverage:getSchedule`).
 */

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Coverage Agent schedule toggle + cron persist', async () => {
  ctx = await launchApp({ seedFixtures: { mode: 'observe', agents: ['qa-hunter'] } });
  const page = ctx.window;

  await page.getByRole('button', { name: 'Coverage', exact: true }).click();

  const card = page.getByTestId('coverage-agent-card');
  await expect(card).toBeVisible({ timeout: 15_000 });

  const toggle = page.getByTestId('coverage-agent-schedule-enabled');
  await expect(toggle).not.toBeChecked();

  // Enabling the schedule lets the cron picker take effect.
  await toggle.check();
  await page.getByTestId('coverage-agent-schedule-cron').selectOption('0 */6 * * *');

  // Assert the backend persisted both.
  const repoId = ctx.fixtures!.repo.id;
  const sched = await page.evaluate(async (id) => {
    const res = await window.obelisk.invoke('coverage:getSchedule', { repoId: id });
    return res.ok ? res.value : null;
  }, repoId);
  expect(sched).toEqual({ enabled: true, cron: '0 */6 * * *' });
});
