import { test, expect } from '@playwright/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures/launch';

/**
 * Drop a stub `xcodebuild` next to the stub `claude`. The stub answers the
 * two queries the doctor's auto-detect step makes (`-list -json` and
 * `-showBuildSettings -json`) with values that point at a `.app` inside
 * the seeded repo. The product path is derived from the `-derivedDataPath`
 * argument so it matches what xcode-detect.ts computes (BUILT_PRODUCTS_DIR
 * = ${derivedDataPath}/Build/Products/Debug-iphonesimulator).
 */
function writeXcodebuildStub(binDir: string, bundleId: string, wrapperName: string): void {
  const stubPath = join(binDir, 'xcodebuild');
  writeFileSync(
    stubPath,
    `#!/bin/sh
all="$*"
case "$all" in
  *"-list -json"*)
    cat <<JSON
{"project":{"name":"Fixture","schemes":["Fixture"]}}
JSON
    exit 0
    ;;
  *"-showBuildSettings -json"*)
    derived=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "-derivedDataPath" ]; then
        derived="$arg"
      fi
      prev="$arg"
    done
    cat <<JSON
[{"buildSettings":{"PRODUCT_BUNDLE_IDENTIFIER":"${bundleId}","BUILT_PRODUCTS_DIR":"$derived/Build/Products/Debug-iphonesimulator","WRAPPER_NAME":"${wrapperName}"}}]
JSON
    exit 0
    ;;
esac
exit 0
`,
    'utf8',
  );
  chmodSync(stubPath, 0o755);
}

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
  const firstCard = page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first();
  await expect(firstCard).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText(/nothing to do/i)).toHaveCount(0);

  // Plan tab parity with QA Hunter — the ref now embeds :plan:<id>,
  // so opening the run drawer must surface the plan tab. Before the
  // fix the iOS run drawer only had audit/evidence/reasoning/files.
  await firstCard.click();
  await expect(page.locator('.mc-tab').filter({ hasText: /^plan/ })).toBeVisible({
    timeout: 10_000,
  });
});

test('One-click setup: fresh repo → Run setup auto-creates qa/ios.yml AND a default flow file → Run now dispatches with no manual assignment', async () => {
  // The user-reported gripe: "OUR APP SHOULD DO THIS AUTOMATICALLY".
  // This test starts from the *real* user state — fresh repo, no
  // qa/ios.yml, NO flow files, only an existing test plan — and proves
  // a single click of Run setup is enough:
  //   1. xcodebuild auto-detect writes app_path + bundle_id.
  //   2. The flows directory gets a default app-sweep.flow.md.
  //   3. The Default test plan dropdown auto-picks the only plan.
  //   4. Run now dispatches (no IOS_QA_NOT_CONFIGURED, no IOS_QA_NO_FLOWS,
  //      no TEST_PLAN_REQUIRED).
  writeXcodebuildStub(stubBinDir, 'com.example.detected', 'Fixture.app');

  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        // Critical: NO flows pre-seeded — Run setup must create one or
        // selectTask throws IOS_QA_NO_FLOWS, which is exactly the bug
        // the user kept hitting.
        flows: [],
        setupDone: true,
        simSlots: 2,
        omitIosYml: true,
      },
      testPlans: [{ agentName: 'ios-qa-pilot', name: 'iOS app sweep' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  // Drop a fake .xcodeproj in the repo so findXcodeProject finds something
  // to feed to the stubbed xcodebuild. The directory just needs to exist
  // with the right suffix — its contents don't matter for detection.
  mkdirSync(join(ctx.repoDir, 'Fixture.xcodeproj'));

  const page = ctx.window;
  const ymlPath = join(ctx.repoDir, 'qa', 'ios.yml');
  expect(existsSync(ymlPath)).toBe(false);

  // 1. Open the iOS QA Pilot screen — repo_config row is initially red
  // and the inline form is visible as a fallback for non-Xcode repos.
  await page.getByRole('button', { name: 'iOS QA Pilot', exact: true }).click();
  const doctorRow = page.locator('.card', { hasText: 'Repo config (qa/ios.yml)' });
  await expect(doctorRow).toBeVisible({ timeout: 15_000 });
  await expect(doctorRow).toContainText(/missing/i);

  // 2. Single click on Run setup. Auto-detection happens inside this
  // call — no form, no manual entry.
  await page.getByRole('button', { name: 'Run setup' }).click();

  // 3. qa/ios.yml lands on disk fully populated with the detected values.
  await expect.poll(() => existsSync(ymlPath), { timeout: 30_000 }).toBe(true);
  await expect
    .poll(
      () => {
        try {
          return readFileSync(ymlPath, 'utf8');
        } catch {
          return '';
        }
      },
      { timeout: 30_000 },
    )
    .toMatch(/com\.example\.detected/);

  const written = readFileSync(ymlPath, 'utf8');
  expect(written).toMatch(/bundle_id:\s*com\.example\.detected/);
  expect(written).toMatch(
    /app_path:\s*build\/Build\/Products\/Debug-iphonesimulator\/Fixture\.app/,
  );

  // 4. The doctor row flips green and the inline form hides.
  await expect(doctorRow).toContainText(/com\.example\.detected/i, { timeout: 15_000 });
  await expect(page.getByTestId('ios-config-form')).toBeHidden({ timeout: 15_000 });

  // 5. A default flow file landed on disk so selectTask doesn't throw
  // IOS_QA_NO_FLOWS. This was the bug the user kept hitting.
  await expect
    .poll(() => existsSync(join(ctx.repoDir, 'qa', 'ios-flows', 'app-sweep.flow.md')), {
      timeout: 15_000,
    })
    .toBe(true);

  // 6. Run now must dispatch all the way to Mission Control. The Default
  // test plan dropdown auto-picks the only plan, so no manual assignment
  // is required.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  // Confirm the dropdown auto-selected the seeded plan (the user did NOT
  // manually pick anything).
  const planSelect = page.getByTestId('agent-default-plan-ios-qa-pilot');
  await expect(planSelect).toBeVisible({ timeout: 15_000 });
  await expect(planSelect).not.toHaveValue('', { timeout: 15_000 });

  const runButton = page.getByTestId('agent-run-now-ios-qa-pilot');
  await expect(runButton).toBeEnabled({ timeout: 15_000 });
  await runButton.click();

  // No "Could not start the run" banner — dispatch must succeed.
  await expect(page.getByTestId('agent-run-error')).toBeHidden({ timeout: 15_000 });

  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('Manual fallback: when no Xcode project is detectable, the form still gets the user to a working run', async () => {
  // Auto-detection only works when there's a .xcodeproj/.xcworkspace in
  // the repo. For non-iOS repos (or unusual layouts), the inline form
  // remains the recovery path. This test proves it still works post-fix.
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        flows: [{ fileName: 'login.flow.md', title: 'Login happy path', priority: 'P0' }],
        setupDone: true,
        simSlots: 2,
        omitIosYml: true,
      },
      testPlans: [{ agentName: 'ios-qa-pilot', name: 'iOS app sweep' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  const page = ctx.window;

  await page.getByRole('button', { name: 'iOS QA Pilot', exact: true }).click();

  const configForm = page.getByTestId('ios-config-form');
  await expect(configForm).toBeVisible({ timeout: 15_000 });

  // Run setup will scaffold an empty qa/ios.yml (detection finds nothing).
  await page.getByRole('button', { name: 'Run setup' }).click();
  await expect
    .poll(() => existsSync(join(ctx.repoDir, 'qa', 'ios.yml')), { timeout: 30_000 })
    .toBe(true);

  // The form remains visible, user types values, saves.
  await expect(configForm).toBeVisible();
  await page.getByTestId('ios-config-app-path').fill('build/Debug-iphonesimulator/Fixture.app');
  await page.getByTestId('ios-config-bundle-id').fill('com.example.fixture');
  await page.getByTestId('ios-config-save').click();

  await expect(configForm).toBeHidden({ timeout: 15_000 });

  // Run now dispatches.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();
  await page.getByTestId('agent-run-now-ios-qa-pilot').click();
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('Default test plan: setting it on the Agents screen makes Run now dispatch that plan automatically', async () => {
  // Even when multiple plans target the same agent (which would otherwise
  // cause selectTask to throw "pick one"), the user's saved default plan
  // is dispatched. This is the new "Default test plan" dropdown on the
  // Agents detail page.
  writeXcodebuildStub(stubBinDir, 'com.example.detected', 'Fixture.app');

  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        flows: [{ fileName: 'login.flow.md', title: 'Login happy path', priority: 'P0' }],
        setupDone: true,
        simSlots: 2,
        omitIosYml: true,
      },
      // Two plans both target ios-qa-pilot. Without a default, selectTask
      // would refuse with TEST_PLAN_REQUIRED ("pick one"). With a default,
      // dispatch goes straight through.
      testPlans: [
        { agentName: 'ios-qa-pilot', name: 'iOS smoke', scope: 'feature', feature: 'smoke' },
        { agentName: 'ios-qa-pilot', name: 'iOS app sweep' },
      ],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  mkdirSync(join(ctx.repoDir, 'Fixture.xcodeproj'));

  const page = ctx.window;

  // Auto-fill qa/ios.yml so the doctor passes.
  await page.getByRole('button', { name: 'iOS QA Pilot', exact: true }).click();
  await page.getByRole('button', { name: 'Run setup' }).click();
  await expect
    .poll(() => existsSync(join(ctx.repoDir, 'qa', 'ios.yml')), { timeout: 30_000 })
    .toBe(true);

  // Open the Agents detail for iOS QA Pilot.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();

  // The new Default test plan dropdown lists every plan that targets this
  // agent. Pick one.
  const planSelect = page.getByTestId('agent-default-plan-ios-qa-pilot');
  await expect(planSelect).toBeVisible({ timeout: 15_000 });
  // The select uses plan ids as values; both seeded plans appear.
  const options = await planSelect.locator('option').allInnerTexts();
  expect(options.some((o) => o.includes('iOS smoke'))).toBe(true);
  expect(options.some((o) => o.includes('iOS app sweep'))).toBe(true);

  // Pick the smoke plan as default. The seed fixture computes plan ids
  // from scope/feature: `scope: feature, feature: smoke` → `feature-smoke`.
  // The save IPC fires immediately on change — no separate "save" click.
  await planSelect.selectOption('feature-smoke');

  // Run now must succeed (no plan-disambiguation error) and dispatch a
  // run referencing the chosen plan.
  await page.getByTestId('agent-run-now-ios-qa-pilot').click();
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('Plan reuse across agents: a QA Hunter plan can be extended to ios-qa-pilot via the chips and dispatched', async () => {
  // The user-reported scenario: they had one "Full app sweep" plan
  // assigned to QA Hunter, but iOS QA Pilot refused to run because
  // listPlans returned nothing for ios-qa-pilot. Plans are now multi-
  // agent — clicking the iOS QA Pilot chip in the editor adds it to
  // the plan's agentNames and Run now starts working.
  writeXcodebuildStub(stubBinDir, 'com.example.detected', 'Fixture.app');

  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['qa-hunter', 'ios-qa-pilot'],
      iosQaPilot: {
        flows: [{ fileName: 'login.flow.md', title: 'Login happy path', priority: 'P0' }],
        setupDone: true,
        simSlots: 2,
        // qa/ios.yml is omitted — Run setup auto-detects via xcodebuild stub.
        omitIosYml: true,
      },
      // Critical: only ONE plan exists, assigned to QA Hunter (not ios-qa-pilot).
      testPlans: [{ agentName: 'qa-hunter', name: 'Full app sweep' }],
    },
    pathOverride: `${stubBinDir}:/usr/bin:/bin`,
  });

  // Drop a fake .xcodeproj so auto-detection fills qa/ios.yml.
  mkdirSync(join(ctx.repoDir, 'Fixture.xcodeproj'));

  const page = ctx.window;

  // 1. Run setup on the iOS QA Pilot screen so qa/ios.yml gets auto-filled.
  await page.getByRole('button', { name: 'iOS QA Pilot', exact: true }).click();
  await page.getByRole('button', { name: 'Run setup' }).click();
  await expect
    .poll(() => existsSync(join(ctx.repoDir, 'qa', 'ios.yml')), { timeout: 30_000 })
    .toBe(true);

  // 2. Going to the Agents page and clicking Run now WOULD fail with
  // TEST_PLAN_REQUIRED because the only plan is for qa-hunter — so we
  // first open Test Plans and add ios-qa-pilot to the existing plan.
  await page.getByRole('button', { name: 'Test Plans', exact: true }).click();

  // The plan editor renders chips for each QA agent. Click iOS QA Pilot
  // to add it to the plan's agentNames.
  const iosChip = page.getByTestId('plan-agent-chip-ios-qa-pilot');
  await expect(iosChip).toBeVisible({ timeout: 15_000 });
  await expect(iosChip).toHaveAttribute('aria-pressed', 'false');
  await iosChip.click();
  await expect(iosChip).toHaveAttribute('aria-pressed', 'true');

  // Briefly wait for the save IPC to complete by reading the file from disk.
  await expect
    .poll(
      () => {
        try {
          const files = require('node:fs').readdirSync(
            join(ctx.repoDir, 'qa', 'test-plans'),
          ) as string[];
          const md = files.length
            ? require('node:fs').readFileSync(
                join(ctx.repoDir, 'qa', 'test-plans', files[0]!),
                'utf8',
              )
            : '';
          return md;
        } catch {
          return '';
        }
      },
      { timeout: 15_000 },
    )
    .toContain('ios-qa-pilot');

  // 3. With the plan now also targeting ios-qa-pilot, Run now dispatches.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const listItem = page.getByTestId('agent-list-item-ios-qa-pilot');
  await expect(listItem).toBeVisible({ timeout: 15_000 });
  await listItem.click();
  await page.getByTestId('agent-run-now-ios-qa-pilot').click();

  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 30_000,
  });
});

// Memory write end-to-end is covered by the unit test
// `orchestrator-ios-qa-pilot.test.ts:"interpretResult writes
// qa/ios-pilot-memory.md when the agent emits BEGIN_IOS_MEMORY_UPDATE"`.
// Reproducing the flow from a Playwright e2e adds stream-json plumbing
// noise without strengthening the assertion — the unit test already
// drives the same handler against the same MockRecipe shape the real
// runner produces.

test('Run now self-heals on empty flows directory (no Run setup needed): clicking Run now from a fresh repo with a test plan dispatches', async () => {
  // The exact user-reported bug: setup_at is stamped from a previous
  // session, qa/ios.yml is filled in, a test plan exists, but
  // qa/ios-flows is empty and the user clicks Run now WITHOUT going
  // through Run setup. Before the fix this surfaced a dead-end
  // IOS_QA_NO_FLOWS banner with no actionable button. After the fix
  // selectTask scaffolds a default flow inline and dispatches.
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        flows: [], // empty — the bug repro
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
  await expect(runButton).toBeEnabled({ timeout: 15_000 });
  await runButton.click();

  // No error banner — selectTask scaffolded a default flow and
  // dispatched.
  await expect(page.getByTestId('agent-run-error')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('.mc-stage').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mc-card').filter({ hasText: 'ios-qa:' }).first()).toBeVisible({
    timeout: 30_000,
  });

  // The scaffolded flow file landed on disk so subsequent runs reuse it.
  expect(existsSync(join(ctx.repoDir, 'qa', 'ios-flows', 'app-sweep.flow.md'))).toBe(true);
});

test('Run now surfaces IOS_QA_NOT_CONFIGURED when qa/ios.yml is missing — and Doctor flags it', async () => {
  // Reproduces the user-reported disconnect: Doctor was reporting "Setup
  // healthy" because it only inspected the environment (Xcode, Appium,
  // sim pool, setup_at). The per-repo qa/ios.yml file was never checked,
  // so Run now would fail with IOS_QA_NOT_CONFIGURED on a "healthy" agent.
  ctx = await launchApp({
    seedFixtures: {
      mode: 'observe',
      agents: ['ios-qa-pilot'],
      iosQaPilot: {
        flows: [{ fileName: 'login.flow.md', title: 'Login happy path', priority: 'P0' }],
        setupDone: true,
        simSlots: 2,
        omitIosYml: true,
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

  // Run now must surface the actionable IOS_QA_NOT_CONFIGURED error rather
  // than a generic dispatch failure.
  const errorBanner = page.getByTestId('agent-run-error');
  await expect(errorBanner).toBeVisible({ timeout: 15_000 });
  await expect(errorBanner).toContainText(/qa\/ios\.yml/i);
  await expect(errorBanner).toContainText(/app_path/i);
  await expect(errorBanner).toContainText(/bundle_id/i);

  await expect(runButton).toBeEnabled();
});
