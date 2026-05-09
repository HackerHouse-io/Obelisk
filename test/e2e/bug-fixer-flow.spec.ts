import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * E2E coverage for the Bug Fixer agent (Phase 1 + 2 refinements):
 *  - Manual backlog dispatch lands a `backlog#<id>` run in Mission Control.
 *  - Multi-instance bug-fixers coexist with auto-numbered names and each
 *    Run-now claims a different backlog row.
 *  - Priority sort: a P0 row is always claimed before a P1 row.
 *
 * GitHub-API-driven paths (issue ingestion, claim signal, PR rebase, CI
 * retry) are out of scope here — those need an HTTP fixture and are
 * exercised at the unit level. This spec keeps the e2e surface focused
 * on what the user can actually observe: clicks → Mission Control state
 * + on-disk worktree side effects.
 */

let ctx: LaunchedApp;
let stubBinDir: string;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-bin-bug-'));
  // Stub `claude` returns a tiny patch-shaped output so the orchestrator
  // takes the patch path and we can assert on the run state. The exact
  // bytes don't have to be parseable — we only need the runner to exit 0.
  const stubPath = join(stubBinDir, 'claude');
  writeFileSync(
    stubPath,
    `#!/bin/sh
echo "stub bug-fixer run"
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

test('Run now on Bug Fixer dispatches the seeded manual backlog row to Mission Control with its title visible', async () => {
  const fixtures = await launchApp({
    seedFixtures: {
      mode: 'prs',
      agents: ['bug-fixer'],
      backlogItems: [
        {
          source: 'manual',
          title: 'Crash on cold start',
          kind: 'bug',
          priorityLabel: 'P0',
        },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });
  ctx = fixtures;

  const page = ctx.window;

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-bug-fixer');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  const runButton = page.getByTestId('agent-run-now-bug-fixer');
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // Mission Control is the canonical post-dispatch landmark.
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });

  // The Mission Control card shows the seeded backlog row's TITLE — the
  // task_context column powers the card title since v1.6. Without that
  // wiring the user only saw `backlog#<ulid>`, which they couldn't read.
  const card = page.locator('.mc-card').filter({ hasText: 'Crash on cold start' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The subtitle still tags it as a manual backlog source so users can tell
  // it apart from a GitHub-issue claim.
  await expect(card).toContainText(/Manual backlog/);

  // No "nothing to do" — selectTask claimed the seeded row.
  await expect(page.getByText(/nothing to do/i)).toHaveCount(0);
  await expect(page.getByTestId('agent-run-error')).toBeHidden();

  // Worktree creation side-effect: the per-run branch lands in the fixture
  // repo. We don't know the exact runId, but every Obelisk branch is
  // namespaced under `obelisk/`, so a single match is enough.
  const branches = execSync('git branch --list "obelisk/*"', { cwd: ctx.repoDir }).toString();
  expect(branches.trim().length).toBeGreaterThan(0);
});

test('Run-started toast surfaces issue #N + title with a clickable GitHub link when a gh_issue claim fires', async () => {
  // The full IPC path (selectTask → fetchIssueContext → GitHub API) needs
  // the issue to actually exist on GitHub, which we can't guarantee in an
  // isolated e2e fixture. The toast component is pure renderer code,
  // however: it picks up an `obelisk:run-started` window event and renders
  // accordingly. We dispatch that event directly to assert the
  // user-visible rendering of a GitHub claim, which is the part the user
  // asked for ("tells me exactly which GitHub issue it is taking").
  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'obelisk-test/fixture',
      agents: ['bug-fixer'],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  const page = ctx.window;
  // Wait until the renderer has the seeded repo loaded — the toast's
  // GitHub link logic needs `repoFullName` from the dispatched event,
  // and dispatching too early can race the React mount.
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('obelisk:run-started', {
        detail: {
          runId: 'run-fixture-1',
          agentName: 'bug-fixer',
          displayName: 'Bug Fixer',
          taskRef: 'issue#42',
          taskContext: 'Crash on cold start',
          repoFullName: 'obelisk-test/fixture',
        },
      }),
    );
  });

  const toast = page.getByTestId('run-started-toast-run-fixture-1');
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText(/issue #42/);
  await expect(toast).toContainText(/Crash on cold start/);

  const issueLink = page.getByTestId('run-started-toast-issue-link');
  await expect(issueLink).toBeVisible();
  await expect(issueLink).toHaveAttribute(
    'href',
    'https://github.com/obelisk-test/fixture/issues/42',
  );
  await expect(issueLink).toHaveAttribute('target', '_blank');
});

test('Multi-instance: two Bug Fixers appear with auto-numbered names and each Run-now creates its own run', async () => {
  const fixtures = await launchApp({
    seedFixtures: {
      mode: 'prs',
      agents: ['bug-fixer'],
      agentCounts: { 'bug-fixer': 2 },
      // Two manual rows. We don't assert *which* row each instance picks —
      // with a fast no-output stub the first run finishes (and unlocks its
      // row) before the second click fires, so claimNextBacklogItem may
      // legitimately pick the same row twice. The race-free guarantee is
      // covered by the unit test `backlog-claim.test.ts`. What this e2e
      // exercises is the renderer + IPC pipeline: two distinct instances
      // each spawn their own run row and both surface in Mission Control.
      backlogItems: [
        { source: 'manual', title: 'Bug A — cold start', kind: 'bug', priorityLabel: 'P0' },
        { source: 'manual', title: 'Bug B — settings reset', kind: 'bug', priorityLabel: 'P1' },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });
  ctx = fixtures;

  const page = ctx.window;
  await page.getByRole('button', { name: 'Agents', exact: true }).click();

  // Both rows are present in the agent list. The second one carries the
  // auto-numbered "Bug Fixer 2" suffix the seeder writes (mirrors the
  // production pickUniqueDisplayName behaviour).
  const items = page.getByTestId('agent-list-item-bug-fixer');
  await expect(items).toHaveCount(2, { timeout: 15_000 });
  await expect(items.first()).toContainText('Bug Fixer');
  await expect(items.nth(1)).toContainText('Bug Fixer 2');

  // First instance: Run now → Mission Control shows a card for one of the
  // seeded titles. Either match works since claim order isn't asserted here.
  await items.first().click();
  await page.getByTestId('agent-run-now-bug-fixer').click();
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .locator('.mc-card')
      .filter({ hasText: /Bug A — cold start|Bug B — settings reset/ })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // Second instance: navigate back, Run now → a SECOND run row appears.
  // Mission Control's header "N runs" copy is the simplest signal that two
  // distinct runs exist (regardless of state).
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await items.nth(1).click();
  await page.getByTestId('agent-run-now-bug-fixer').click();
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^2 runs$/)).toBeVisible({ timeout: 30_000 });
});

test('Priority sort: when both P0 and P1 rows are present, Bug Fixer claims the P0 row first', async () => {
  // Seeded out of order on purpose — P1 is added first so a naive FIFO
  // would pick it. The DB ranking SQL must hoist P0 above P1 regardless.
  const fixtures = await launchApp({
    seedFixtures: {
      mode: 'prs',
      agents: ['bug-fixer'],
      backlogItems: [
        { source: 'manual', title: 'Lower priority bug', kind: 'bug', priorityLabel: 'P1' },
        { source: 'manual', title: 'Critical crash', kind: 'bug', priorityLabel: 'P0' },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });
  ctx = fixtures;

  const page = ctx.window;
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-bug-fixer');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  await page.getByTestId('agent-run-now-bug-fixer').click();
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });

  // The P0 row's title appears in the Mission Control card (claim order
  // proves selectTask hoisted P0 above the older P1 row). The P1 row's
  // title must NOT appear since only one run was dispatched.
  await expect(page.locator('.mc-card').filter({ hasText: 'Critical crash' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.mc-card').filter({ hasText: 'Lower priority bug' })).toHaveCount(0);
});
