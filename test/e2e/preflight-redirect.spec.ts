import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Run iOS QA Pilot does not silently dispatch when preflight fails', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
    },
  });

  const page = ctx.window;
  const runButton = page.getByTestId('run-ios-qa-pilot').first();
  await expect(runButton).toBeVisible({ timeout: 15_000 });

  await runButton.click();

  // On a developer machine without a working iOS simulator, one of two
  // outcomes is acceptable — both are non-silent:
  //   (a) doctor returns 'red' → routed to the QA screen for setup
  //   (b) doctor IPC errors    → inline error banner on Home
  // Both indicate the click was handled with feedback. What's NOT acceptable:
  // landing in Mission Control with a failing run (the original bug).
  const qaHeader = page.getByText('iOS QA Pilot', { exact: true }).first();
  const errorBanner = page.getByTestId('run-error');
  await expect(qaHeader.or(errorBanner)).toBeVisible({ timeout: 20_000 });

  // No Mission Control run row.
  await expect(page.locator('.mc-card, .mc-run-card')).toHaveCount(0);
});
