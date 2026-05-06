import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('Run QA Hunter surfaces inline error when no runner is installed', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter' }],
    },
  });

  const page = ctx.window;
  const runButton = page.getByTestId('run-qa-hunter').first();
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await expect(runButton).toBeEnabled();

  await runButton.click();

  // The bottom-line user feedback we care about: an inline error banner
  // explains what went wrong (no silent failure into Mission Control).
  const errorBanner = page.getByTestId('run-error');
  await expect(errorBanner).toBeVisible({ timeout: 15_000 });
  await expect(errorBanner).toContainText(/Could not start agent/);
  await expect(errorBanner).toContainText(/(not installed|RUNNER|claude|codex)/i);

  // Button is reusable so the user can retry after fixing PATH.
  await expect(runButton).toBeEnabled();
  await expect(runButton).toContainText('Run QA Hunter');

  // Dismissing the banner removes it.
  await errorBanner.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(errorBanner).toBeHidden();
});

test('Run button reflects pending state via aria-disabled while IPC is in flight', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter' }],
    },
  });

  const page = ctx.window;
  const runButton = page.getByTestId('run-qa-hunter').first();
  await expect(runButton).toBeVisible({ timeout: 15_000 });

  // Race the click with a snapshot of the post-click state. We can't rely on
  // Playwright's async polling here because the IPC resolves faster than the
  // first poll on a healthy machine. Capture the "post-click, pre-resolve"
  // attribute set inside an evaluate() callback so we observe the React
  // state-update synchronously after the dispatch.
  const observedDuringClick = await page.evaluate(async () => {
    const btn = document.querySelector(
      '[data-testid="run-qa-hunter"]',
    ) as HTMLButtonElement | null;
    if (!btn) return { found: false };
    btn.click();
    // Wait one microtask so React applies the synchronous setRunState.
    await Promise.resolve();
    await Promise.resolve();
    return {
      found: true,
      disabled: btn.disabled,
      text: btn.textContent ?? '',
    };
  });

  expect(observedDuringClick.found).toBe(true);
  expect(observedDuringClick.disabled).toBe(true);
  expect(observedDuringClick.text).toMatch(/Starting/);

  // And the eventual error path still works.
  await expect(page.getByTestId('run-error')).toBeVisible({ timeout: 15_000 });
});
