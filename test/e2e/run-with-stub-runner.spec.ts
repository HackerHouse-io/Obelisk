import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * These tests verify the *positive* run-button path: when a runner CLI is
 * available, clicking Run dispatches the orchestrator and navigates to
 * Mission Control. We use a tiny shell stub instead of the real `claude`
 * or `codex` binaries so the test stays self-contained.
 */

let ctx: LaunchedApp;
let stubBinDir: string;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-bin-'));
  // Tiny `claude` stub: prints "OK" then exits 0 (the orchestrator will
  // treat 'no_changes' as success for read-only agents like qa-hunter).
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

test('Run QA Hunter dispatches the run and navigates to Mission Control when a runner is on PATH', async () => {
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter'],
      testPlans: [{ agentName: 'qa-hunter' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  const page = ctx.window;
  const runButton = page.getByTestId('run-qa-hunter').first();
  await expect(runButton).toBeVisible({ timeout: 15_000 });

  await runButton.click();

  // Successful dispatch navigates to Mission Control. The pipeline view's
  // header is the canonical landmark for that screen.
  await expect(
    page
      .getByRole('heading', { name: /Mission Control|Pipeline/i })
      .or(page.locator('.mc-stage').first()),
  ).toBeVisible({ timeout: 15_000 });

  // The run row eventually appears on the canvas (queued/running/done all
  // satisfy this — we just want to confirm the orchestrator was invoked).
  await expect(page.locator('.mc-card, .mc-run-card, [data-run-id]').first()).toBeVisible({
    timeout: 15_000,
  });
});
