import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * Regression coverage for the iOS QA Pilot "Run now" path.
 *
 * The bug we're guarding against: a generic "Could not start the run —
 * nothing to do" message would surface even when the agent was fully set
 * up (qa/ios.yml present, Doctor stamped setup_at, flow files exist,
 * simulator slots seeded, test plan registered). The user had no way to
 * tell whether they were missing setup, flows, a plan, or a slot.
 *
 * The fix throws specific, actionable errors for each precondition gap
 * (IOS_QA_NOT_CONFIGURED / IOS_QA_SETUP_REQUIRED / IOS_QA_NO_FLOWS /
 * IOS_QA_NOTHING_CLAIMABLE / IOS_QA_POOL_FULL) and lets a healthy run
 * dispatch all the way to Mission Control.
 */

let ctx: LaunchedApp;
let stubBinDir: string;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-bin-ios-'));
  const stubPath = join(stubBinDir, 'claude');
  writeFileSync(
    stubPath,
    `#!/bin/sh
echo "stub claude run"
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

test('Run now on iOS QA Pilot dispatches when setup is done, flows exist, and pool has slots', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        flows: [
          { fileName: 'login.flow.md', title: 'Login happy path', priority: 'P0' },
          { fileName: 'signup.flow.md', title: 'Signup', priority: 'P1' },
        ],
        setupDone: true,
        simSlots: 2,
      },
      testPlans: [{ agentName: 'ios-qa-pilot', name: 'iOS app sweep' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  const page = ctx.window;

  // Navigate to Agents sidebar entry, then select the iOS QA Pilot row.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  const runButton = page.getByTestId('agent-run-now-ios-qa-pilot');
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // Successful dispatch routes to Mission Control. If the run errors
  // out *after* createRun, that's still acceptable — the bug we care
  // about is selectTask returning null with no actionable message. We
  // assert the route changed (Mission Control's stage container is
  // present) AND that the run row exists with the iOS QA Pilot's
  // characteristic `ios-qa:<flow_id>:` task-ref shape.
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.getByText(/nothing to do/i)).toHaveCount(0);
});

test('Run now surfaces IOS_QA_NO_FLOWS instead of "nothing to do" when the flows directory is empty', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        // setup is done and slots exist, but the flows array is empty so
        // selectTask hits the IOS_QA_NO_FLOWS branch.
        flows: [],
        setupDone: true,
        simSlots: 2,
      },
      testPlans: [{ agentName: 'ios-qa-pilot', name: 'iOS app sweep' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  const page = ctx.window;

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  const runButton = page.getByTestId('agent-run-now-ios-qa-pilot');
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await runButton.click();

  // The bug repro: a stale build would show "nothing to do" here. After
  // the fix, the user sees the specific IOS_QA_NO_FLOWS error pointing
  // them at qa/ios-flows.
  const errorBanner = page.getByTestId('agent-run-error');
  await expect(errorBanner).toBeVisible({ timeout: 15_000 });
  await expect(errorBanner).not.toContainText(/nothing to do/i);
  await expect(errorBanner).toContainText(/qa\/ios-flows|flow files|flow file/i);

  await expect(runButton).toBeEnabled();
});
