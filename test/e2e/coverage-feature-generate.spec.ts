import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * Feature card "Generate test plan" UX guards:
 *
 *   - Disabled while a generation job for the same feature is in flight
 *   - Stays disabled when the user navigates away and comes back
 *   - Backend refuses to spawn a second job for the same feature
 *
 * Uses a SLOW stub Claude that sleeps before emitting the plan so the
 * test has a stable window in which to observe the in-flight state.
 */

const PLAN_OUTPUT = `BEGIN_TEST_PLAN
{
  "blocks": [
    { "kind": "section", "title": "Smoke" },
    { "kind": "case", "title": "Boots without errors", "expected": "Renders", "repro": "Open app", "severity": "P0", "scope": ["smoke"] }
  ]
}
END_TEST_PLAN`;

function slowStubClaude(sleepSeconds: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-stub-plan-slow-'));
  const stub = join(dir, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  --version) echo "claude 0.0.0-stub"; exit 0 ;;
esac
sleep ${sleepSeconds}
cat <<'EOF'
${PLAN_OUTPUT}
EOF
exit 0
`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  return dir;
}

function seedCodeFiles(repoDir: string): void {
  const files = [
    'src/wealthlab/auth.ts',
    'src/wealthlab/charts.ts',
    'src/wealthlab/data.ts',
    'src/main/index.ts',
    'src/renderer/screens/Coverage.tsx',
  ];
  for (const f of files) {
    const full = join(repoDir, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// seed\n');
  }
  // Plant a coverage map so a feature card shows up.
  mkdirSync(join(repoDir, 'qa'), { recursive: true });
  writeFileSync(
    join(repoDir, 'qa', 'coverage-map.md'),
    '# Coverage map\n\n- `wealthlab`: `src/wealthlab/**`\n',
  );
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -q -m "seed"', { cwd: repoDir });
}

let ctx: LaunchedApp;
let stubDir: string | null = null;

test.afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = null;
});

test('Feature card Generate button disables while a plan job is in flight', async () => {
  // Stub takes ~6s so we have time to observe the in-flight state.
  stubDir = slowStubClaude(6);
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  const genBtn = page.getByTestId('feature-card-generate-wealthlab');
  await expect(genBtn).toBeVisible({ timeout: 15_000 });
  await expect(genBtn).toBeEnabled();
  await expect(genBtn).toHaveAttribute('data-generating', 'false');

  await genBtn.click();

  // Within a second or two, the button should flip to the in-flight state.
  await expect(genBtn).toHaveAttribute('data-generating', 'true', { timeout: 10_000 });
  await expect(genBtn).toBeDisabled();
  // Label reflects the live stage.
  await expect(genBtn).toContainText(/Queued|Starting|Reading|Drafting|Saving|Generating/);

  // Clicking again does nothing — the button stays disabled and no second
  // job is spawned. We assert this via the backend's job list (1 in-flight).
  await genBtn.click({ force: true });
  await page.waitForTimeout(500);
  const jobsHandle = await page.evaluateHandle(async () => {
    const res = await window.obelisk.invoke('testPlans:generationJobs', {});
    return res.ok ? res.value : [];
  });
  const jobs = (await jobsHandle.jsonValue()) as { jobId: string; stage: string }[];
  const inflight = jobs.filter((j) => j.stage !== 'done' && j.stage !== 'failed');
  expect(inflight.length).toBe(1);
});

test('Generate button stays disabled across navigation away and back', async () => {
  stubDir = slowStubClaude(6);
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  const genBtn = page.getByTestId('feature-card-generate-wealthlab');
  await expect(genBtn).toBeVisible({ timeout: 15_000 });
  await genBtn.click();
  await expect(genBtn).toHaveAttribute('data-generating', 'true', { timeout: 10_000 });

  // Navigate away to Mission Control, then back to Coverage.
  await page.getByRole('button', { name: 'Mission Control' }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Coverage' }).first().click();

  // The button is still disabled and shows the in-flight state — the screen
  // hydrated testPlans:generationJobs on mount.
  const reGenBtn = page.getByTestId('feature-card-generate-wealthlab');
  await expect(reGenBtn).toBeVisible({ timeout: 10_000 });
  await expect(reGenBtn).toHaveAttribute('data-generating', 'true', { timeout: 5_000 });
  await expect(reGenBtn).toBeDisabled();
});

test('Feature card flips from Generate-button to agent buttons after a plan is created', async () => {
  // FAST stub (no sleep) so the plan completes within the test timeout.
  stubDir = slowStubClaude(0);
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();

  const genBtn = page.getByTestId('feature-card-generate-wealthlab');
  await expect(genBtn).toBeVisible({ timeout: 15_000 });
  await genBtn.click();

  // The Generate button disappears once the plan is associated with the
  // feature (frontmatter.feature='wealthlab'); the agent run buttons take
  // its place. Use a poll because the bus event → refresh → re-render
  // chain takes a moment.
  await expect
    .poll(async () => page.getByTestId('feature-card-generate-wealthlab').count(), {
      timeout: 20_000,
    })
    .toBe(0);
  // QA Hunter run button is now visible on the Wealthlab card.
  const card = page
    .locator('.coverage-feature-card', { has: page.getByText('wealthlab', { exact: false }) })
    .first();
  await expect(card.getByRole('button', { name: /QA Hunter/i })).toBeVisible({ timeout: 5_000 });
});

test('Attach existing plan dropdown rebinds a plan to this feature', async () => {
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  // Plant an existing plan whose frontmatter.feature is a DIFFERENT
  // feature so the wealthlab card is unbound at start.
  const plansDir = join(ctx.repoDir, 'qa', 'test-plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, 'legacy-plan.md'),
    [
      '---',
      'id: legacy-plan',
      'name: My legacy plan',
      'scope: whole-app',
      'feature: null',
      'agentNames: [qa-hunter, manual-qa, ios-qa-pilot]',
      'generatedAt: 2026-05-07T12:00:00Z',
      'generatedBy: heuristic',
      'version: 1',
      '---',
      '',
      '## Smoke',
      '',
      '- [ ] Some case',
      '  - **Expected:** ok',
      '  - **Repro:** ok',
      '',
    ].join('\n'),
  );
  execSync('git add . && git commit -q -m "plan"', { cwd: ctx.repoDir });

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  // Card has Generate button (no plan bound yet).
  const genBtn = page.getByTestId('feature-card-generate-wealthlab');
  await expect(genBtn).toBeVisible({ timeout: 15_000 });

  // Open attach dropdown, click the legacy plan.
  await page.getByTestId('feature-card-attach-wealthlab').click();
  await expect(page.getByText('My legacy plan')).toBeVisible({ timeout: 5_000 });
  await page.getByText('My legacy plan').click();

  // Within a couple seconds, the card flips: Generate disappears, agent
  // buttons appear.
  await expect
    .poll(async () => page.getByTestId('feature-card-generate-wealthlab').count(), {
      timeout: 15_000,
    })
    .toBe(0);
  const card = page
    .locator('.coverage-feature-card', { has: page.getByText('wealthlab', { exact: false }) })
    .first();
  await expect(card.getByRole('button', { name: /QA Hunter/i })).toBeVisible({ timeout: 5_000 });
});

test('Backend refuses a duplicate plan job for the same feature', async () => {
  stubDir = slowStubClaude(6);
  ctx = await launchApp({
    seedFixtures: { mode: 'observe', agents: ['qa-hunter'] },
    pathOverride: `${stubDir}:/usr/bin:/bin`,
  });
  const page = ctx.window;
  seedCodeFiles(ctx.repoDir);

  await page.getByRole('button', { name: 'Coverage' }).first().click();
  await page.getByTestId('feature-card-generate-wealthlab').click();
  // Wait for the job to actually be in flight.
  await expect(page.getByTestId('feature-card-generate-wealthlab')).toHaveAttribute(
    'data-generating',
    'true',
    { timeout: 10_000 },
  );

  // Directly call the IPC twice with identical args — the second call should
  // return the SAME jobId as the first (dedup by repo+scope+feature).
  const first = (await page.evaluate(async () => {
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId: (await window.obelisk.invoke('repos:list', undefined)).value![0]!.id,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'wealthlab',
    });
    return res.ok ? res.value.jobId : null;
  })) as string;
  const second = (await page.evaluate(async () => {
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId: (await window.obelisk.invoke('repos:list', undefined)).value![0]!.id,
      agentName: 'qa-hunter',
      scope: 'feature',
      featureName: 'wealthlab',
    });
    return res.ok ? res.value.jobId : null;
  })) as string;
  expect(first).toBeTruthy();
  expect(second).toBe(first);

  // Confirm only ONE in-flight job exists for this feature.
  const jobs = (await page.evaluate(async () => {
    const res = await window.obelisk.invoke('testPlans:generationJobs', {});
    return res.ok ? res.value : [];
  })) as { jobId: string; feature: string | null; stage: string }[];
  const inflight = jobs.filter(
    (j) => j.feature === 'wealthlab' && j.stage !== 'done' && j.stage !== 'failed',
  );
  expect(inflight.length).toBe(1);
});
