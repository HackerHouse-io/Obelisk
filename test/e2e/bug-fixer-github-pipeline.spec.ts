import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';
import { startGithubStub, type GithubStubHandle } from './fixtures/github-stub';

/**
 * E2E coverage for the bug-fixer Run-now flow against a real HTTP
 * round-trip to a stub GitHub server. The test starts from the same
 * state a real user has after connecting a repo:
 *   - repo row exists in the DB (a single one-time setup, mirroring
 *     `repos:connect`)
 *   - a `bug-fixer` agent instance exists (created by `repos:connect`)
 *   - the **backlog table is EMPTY** — exactly what the user sees on a
 *     freshly-connected repo before the periodic sync (~2 min) fires.
 *
 * Then the test drives the same UI clicks a real user would: open the
 * Agents screen, click into the bug-fixer, click Run now. The asserted
 * outcomes are user-visible (Mission Control card appears, no error
 * banner) AND the GitHub stub records the canonical claim sequence
 * (issues fetch → label/assignee POSTs).
 *
 * This replaces an earlier version that seeded the backlog table
 * directly. That test passed while production failed, because the
 * "Run now triggers an inline backlog sync" path was never exercised.
 */

let ctx: LaunchedApp;
let stub: GithubStubHandle | undefined;
let stubBinDir: string;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-bin-pipeline-'));
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
  if (stub) {
    await stub.close().catch(() => undefined);
    stub = undefined;
  }
  if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
});

test('User clicks Run now on a freshly-connected repo with empty backlog: bug-fixer syncs from GitHub inline, claims the P0 issue, and dispatches', async () => {
  // GitHub stub returns one open P0 issue. The user has NEVER run the
  // periodic sync for this repo yet, so their local backlog is empty.
  stub = await startGithubStub({
    authedLogin: 'obelisk-test-user',
    issues: [
      {
        number: 42,
        title: 'Crash on cold start',
        state: 'open',
        user: { login: 'allowed-author' },
        labels: [{ name: 'obelisk:fix' }, { name: 'P0' }],
        assignees: [],
      },
    ],
  });

  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'acme/app',
      agents: ['bug-fixer'],
      // CRITICAL: no `backlogItems`. The test starts in the exact
      // state a real user is in right after connecting a repo — DB
      // has a repos row + an agent row, but no backlog.
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
    githubBaseUrl: stub.baseUrl,
    authedLoginOverride: 'obelisk-test-user',
  });

  const page = ctx.window;

  // 1. User clicks "Agents" in the sidebar.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();

  // 2. User clicks into their bug-fixer instance.
  const listItem = page.getByTestId('agent-list-item-bug-fixer');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  // 3. User clicks Run now.
  const runButton = page.getByTestId('agent-run-now-bug-fixer');
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // 4. Mission Control opens with a card for the GitHub issue. The
  //    issue title comes from the inline-synced backlog row; the
  //    subtitle "GitHub issue #42" comes from the run row's task_ref.
  //    No "Could not start the run" banner.
  await expect(page.getByTestId('agent-run-error')).toBeHidden();
  const card = page.locator('.mc-card').filter({ hasText: 'Crash on cold start' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/GitHub issue #42/);

  // 5. The stub recorded the canonical Run-now → claim sequence:
  //    inline sync (GET /repos/.../issues), then per-issue context
  //    (GET /issues/42), then claim signals (POST labels + POST
  //    assignees). We assert on the request log so the regression is
  //    visible if any step is silently dropped.
  await page.waitForTimeout(1500);
  const reqs = stub.requests;
  expect(
    reqs.some((r) => r.method === 'GET' && r.path.startsWith('/repos/acme/app/issues?')),
  ).toBe(true);
  expect(reqs.some((r) => r.method === 'GET' && r.path === '/repos/acme/app/issues/42')).toBe(
    true,
  );
  const labelPost = reqs.find(
    (r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/labels',
  );
  expect(labelPost?.body).toMatchObject({ labels: ['obelisk:in-progress'] });
  const assigneePost = reqs.find(
    (r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/assignees',
  );
  expect(assigneePost?.body).toMatchObject({ assignees: ['obelisk-test-user'] });
});

test('User clicks Run now and the only open issue is already claimed by another Obelisk install: bug-fixer skips it, surfaces an actionable error', async () => {
  // The cross-installation signature: obelisk:in-progress label AND
  // the connected user is on the assignees. selectTask must skip and
  // throw BACKLOG_ALL_FILTERED so the renderer shows a clear hint
  // instead of the generic "nothing to do".
  stub = await startGithubStub({
    authedLogin: 'obelisk-test-user',
    issues: [
      {
        number: 99,
        title: 'Already taken by sibling install',
        state: 'open',
        user: { login: 'allowed-author' },
        labels: [{ name: 'obelisk:fix' }, { name: 'obelisk:in-progress' }],
        assignees: [{ login: 'obelisk-test-user' }],
      },
    ],
  });

  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'acme/app',
      agents: ['bug-fixer'],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
    githubBaseUrl: stub.baseUrl,
    authedLoginOverride: 'obelisk-test-user',
  });

  const page = ctx.window;
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByTestId('agent-list-item-bug-fixer').click();
  await page.getByTestId('agent-run-now-bug-fixer').click();

  // The error banner appears with the cross-install reason. No silent
  // "nothing to do" — the user knows exactly why nothing ran.
  const banner = page.getByTestId('agent-run-error');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/already claimed by another Obelisk install/i);

  // No POST labels / assignees were submitted — the cross-install
  // guard short-circuited before any signal write.
  await page.waitForTimeout(1500);
  const reqs = stub.requests;
  expect(
    reqs.some(
      (r) =>
        r.method === 'POST' &&
        (r.path === '/repos/acme/app/issues/99/labels' ||
          r.path === '/repos/acme/app/issues/99/assignees'),
    ),
  ).toBe(false);
});

test('User clicks Run now on a repo that has zero open GitHub issues: bug-fixer surfaces BACKLOG_EMPTY with a hint to file an issue', async () => {
  stub = await startGithubStub({
    authedLogin: 'obelisk-test-user',
    issues: [], // genuinely nothing open
  });

  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'acme/app',
      agents: ['bug-fixer'],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
    githubBaseUrl: stub.baseUrl,
    authedLoginOverride: 'obelisk-test-user',
  });

  const page = ctx.window;
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByTestId('agent-list-item-bug-fixer').click();
  await page.getByTestId('agent-run-now-bug-fixer').click();

  // The error banner explains there are no issues — this is the bug
  // the user reported, where the OLD code surfaced "nothing to do"
  // with no path to action.
  const banner = page.getByTestId('agent-run-error');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/No `obelisk:fix` issues/i);
  // The hint tells the user what to do next.
  await expect(banner).toContainText(/Apply the `obelisk:fix` label|manual backlog item/i);
});
