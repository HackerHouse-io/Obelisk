import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';
import { startGithubStub, type GithubStubHandle } from './fixtures/github-stub';

/**
 * E2E coverage for the bug-fixer pipeline against a *real* HTTP round-trip
 * to a stub GitHub server. Closes the "never run end-to-end against
 * GitHub" production-readiness gap without requiring a live repo.
 *
 * The stub responds to:
 *   GET  /user
 *   GET  /repos/.../issues/:n
 *   POST /repos/.../issues/:n/labels       (postClaimSignal)
 *   POST /repos/.../issues/:n/assignees    (postClaimSignal)
 *   DEL  /repos/.../issues/:n/labels/:name (clearClaimSignals)
 *   DEL  /repos/.../issues/:n/assignees    (clearClaimSignals)
 */

let ctx: LaunchedApp;
let stub: GithubStubHandle;
let stubBinDir: string;

test.beforeEach(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), 'obelisk-stub-bin-pipeline-'));
  // The stub `claude` returns no patch, so the run lands in `failed`
  // before the publisher fires. That's fine — this test asserts on the
  // CLAIM/SIGNAL phase of the pipeline, which runs BEFORE the LLM does.
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
  if (stub) await stub.close();
  if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
});

test('Bug Fixer claims a gh_issue backlog row by hitting the GitHub API end-to-end (label + assignee land on the issue)', async () => {
  // Stub a single open GitHub issue authored by an allowlisted user.
  stub = await startGithubStub({
    authedLogin: 'obelisk-test-user',
    issues: [
      {
        number: 42,
        title: 'Crash on cold start',
        state: 'open',
        user: { login: 'allowed-author' },
        labels: [{ name: 'bug' }],
        assignees: [],
      },
    ],
  });

  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'acme/app',
      agents: ['bug-fixer'],
      backlogItems: [
        {
          source: 'gh_issue',
          githubIssue: 42,
          title: 'Crash on cold start',
          kind: 'bug',
          priorityLabel: 'P0',
        },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
    githubBaseUrl: stub.baseUrl,
    authedLoginOverride: 'obelisk-test-user',
  });

  // The seed builds an empty allowlist; for selectTask to admit a
  // gh_issue with author "allowed-author" we need to add them via the
  // existing IPC. Drive the renderer's window.obelisk bridge from
  // page.evaluate so the call rides the same path the UI would.
  const repoId = ctx.fixtures!.repo.id;
  await ctx.window.evaluate(
    async ({ repoId, login }: { repoId: string; login: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).obelisk.invoke('allowlist:add', { repoId, login });
    },
    { repoId, login: 'allowed-author' },
  );

  const page = ctx.window;

  // Click Run now on the bug-fixer.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-bug-fixer');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();
  await page.getByTestId('agent-run-now-bug-fixer').click();

  // The Mission Control card surfaces the issue title — proves the
  // backlog claim landed and the renderer received the run. The card
  // selector is more reliable than `.mc-stage` because a fast-failing
  // run lands directly in Failed, and we're asserting on the card body.
  await expect(
    page.locator('.mc-card').filter({ hasText: 'Crash on cold start' }).first(),
  ).toBeVisible({ timeout: 30_000 });

  // Wait briefly for the orchestrator's selectTask path to hit the stub
  // (fetchIssueContext + postClaimSignal). 1.5s is well past the local
  // round-trip latency for a same-process http server.
  await page.waitForTimeout(1500);

  // The stub MUST have observed the canonical claim sequence:
  //   1. GET /user                  (getAuthedLogin during postClaimSignal)
  //   2. GET .../issues/42          (fetchIssueContext)
  //   3. POST .../issues/42/labels  (apply obelisk:in-progress)
  //   4. POST .../issues/42/assignees (assign the connected user)
  const reqs = stub.requests;
  expect(reqs.some((r) => r.method === 'GET' && r.path === '/repos/acme/app/issues/42')).toBe(true);
  expect(
    reqs.some((r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/labels'),
  ).toBe(true);
  expect(
    reqs.some((r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/assignees'),
  ).toBe(true);

  // Inspect the POST bodies the stub received: the agent must have
  // tried to apply `obelisk:in-progress` and assign the connected user.
  // We assert against the request body (not the stub's final issue
  // state), because the run fails fast — clearClaimSignals fires in
  // the orchestrator's finally hook and removes both signals before
  // the test can observe them. The "got applied at least once" assertion
  // is the truthful one.
  const labelPost = reqs.find(
    (r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/labels',
  );
  expect(labelPost?.body).toMatchObject({ labels: ['obelisk:in-progress'] });

  const assigneePost = reqs.find(
    (r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/42/assignees',
  );
  expect(assigneePost?.body).toMatchObject({ assignees: ['obelisk-test-user'] });

  // And the cleanup actually fired — proves the orchestrator's finally
  // hook works end-to-end against the stub.
  expect(
    reqs.some(
      (r) =>
        r.method === 'DELETE' &&
        r.path.startsWith('/repos/acme/app/issues/42/labels/obelisk%3Ain-progress'),
    ) ||
      reqs.some(
        (r) =>
          r.method === 'DELETE' &&
          r.path === '/repos/acme/app/issues/42/labels/obelisk:in-progress',
      ),
  ).toBe(true);
});

test('Bug Fixer skips an issue another Obelisk install is already working (cross-installation guard)', async () => {
  // Stub the exact "sibling install already claimed it" state: the
  // connected user is already on the assignees AND obelisk:in-progress
  // is on the labels. selectTask must skip this row, NOT submit an
  // additional addLabels/addAssignees call.
  stub = await startGithubStub({
    authedLogin: 'obelisk-test-user',
    issues: [
      {
        number: 99,
        title: 'Already taken',
        state: 'open',
        user: { login: 'allowed-author' },
        labels: [{ name: 'obelisk:in-progress' }],
        assignees: [{ login: 'obelisk-test-user' }],
      },
    ],
  });

  ctx = await launchApp({
    seedFixtures: {
      mode: 'prs',
      repoFullName: 'acme/app',
      agents: ['bug-fixer'],
      backlogItems: [
        {
          source: 'gh_issue',
          githubIssue: 99,
          title: 'Already taken',
          kind: 'bug',
          priorityLabel: 'P0',
        },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
    githubBaseUrl: stub.baseUrl,
    authedLoginOverride: 'obelisk-test-user',
  });

  const repoId2 = ctx.fixtures!.repo.id;
  await ctx.window.evaluate(
    async ({ repoId, login }: { repoId: string; login: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).obelisk.invoke('allowlist:add', { repoId, login });
    },
    { repoId: repoId2, login: 'allowed-author' },
  );

  const page = ctx.window;
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByTestId('agent-list-item-bug-fixer').click();
  await page.getByTestId('agent-run-now-bug-fixer').click();

  // Give the orchestrator + selectTask retry loop time to attempt and
  // skip the row. The selectTask path makes one GET to /issues/99,
  // sees the cross-installation signature, audits, and returns null —
  // the renderer surfaces "No task to work on right now".
  await page.waitForTimeout(2000);

  // Stub MUST have observed the GET issues/99 (the lookup that yielded
  // the conflicting state) but NEVER POST to add labels/assignees.
  const reqs = stub.requests;
  expect(reqs.some((r) => r.method === 'GET' && r.path === '/repos/acme/app/issues/99')).toBe(true);
  expect(
    reqs.some(
      (r) =>
        r.method === 'POST' &&
        (r.path === '/repos/acme/app/issues/99/labels' ||
          r.path === '/repos/acme/app/issues/99/assignees'),
    ),
  ).toBe(false);
});
