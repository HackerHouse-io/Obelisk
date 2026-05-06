import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let ctx: LaunchedApp;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

test('clicking Open issue on a previewed finding opens the review modal pre-populated', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      previews: [
        {
          agentName: 'qa-hunter',
          title: 'Race condition in session refresh',
          body: '## Symptom\n\nSession refresh fails on Safari with strict cookies.\n\n## Steps to reproduce\n1. Open Safari with strict cookies\n2. Wait 30 seconds\n3. Refresh the page\n',
          labels: ['bug', 'severity:P0'],
        },
      ],
    },
  });

  const page = ctx.window;

  // Wait for the seeded preview to render.
  const findingTitle = page.locator('.finding-row-title-text', {
    hasText: 'Race condition in session refresh',
  });
  await expect(findingTitle).toBeVisible({ timeout: 15_000 });

  // Severity pill is rendered from the labels.
  const severityPill = page.locator('.pill.sev-p0').first();
  await expect(severityPill).toBeVisible();
  await expect(severityPill).toHaveText('P0');

  // Open the modal.
  const openIssueButton = page.getByRole('button', { name: /Open issue/i }).first();
  await openIssueButton.click();

  const modal = page.getByRole('dialog', { name: /File issue on GitHub/i });
  await expect(modal).toBeVisible();

  // Title input is pre-populated.
  const titleInput = modal.locator('input.file-issue-input');
  await expect(titleInput).toHaveValue('Race condition in session refresh');

  // Body textarea contains the seeded body.
  const bodyTextarea = modal.locator('textarea.file-issue-textarea');
  await expect(bodyTextarea).toContainText('Session refresh fails on Safari');

  // Labels chips render (with severity excluded from the chip list inside the row,
  // but inside the modal both labels are shown).
  await expect(modal.getByText('bug', { exact: true })).toBeVisible();

  // Cancel returns to the list without filing.
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toBeHidden();
  await expect(findingTitle).toBeVisible();
});

test('Dismiss hides the finding row', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      previews: [
        {
          agentName: 'qa-hunter',
          title: 'False positive ignore me',
          body: 'noise',
          labels: ['bug'],
        },
      ],
    },
  });

  const page = ctx.window;
  const findingTitle = page.locator('.finding-row-title-text', {
    hasText: 'False positive ignore me',
  });
  await expect(findingTitle).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Dismiss' }).first().click();

  // Bus broadcast triggers a refresh; dismissed rows are filtered out.
  await expect(findingTitle).toBeHidden({ timeout: 10_000 });
});
