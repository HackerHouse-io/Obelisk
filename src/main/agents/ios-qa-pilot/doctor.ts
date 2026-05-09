import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootstrapPool, keepBooted, type BootstrapOpts } from './sim-pool';
import { getSetupAt, listSimSlots, setSetupAt } from '../../db/qa-flows';
import { isConfigured, loadIosConfig, saveIosConfig, type IosConfigPatch } from './config';
import { detectIosConfig } from './xcode-detect';
import { scaffoldMemoryFile } from './memory';
import { scaffoldFile } from '../../util/scaffold-file';

const exec = promisify(execFile);

// `appium driver install xcuitest` downloads WebDriverAgent + a few hundred
// npm packages; its stdout regularly exceeds Node's default 1 MB exec buffer
// and kills the process mid-install. 100 MB is plenty.
const SETUP_MAX_BUFFER = 100 * 1024 * 1024;

export type CheckLevel = 'green' | 'yellow' | 'red';

export interface DoctorCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  overall: CheckLevel;
  checks: DoctorCheck[];
  checkedAt: string;
}

export type SetupStep =
  | 'install-appium'
  | 'install-xcuitest'
  | 'bootstrap-pool'
  | 'scaffold-config';

export interface SetupProgress {
  step: SetupStep;
  label: string;
  status: 'started' | 'completed' | 'failed';
}

export interface DoctorOpts {
  repoId: string;
  /**
   * Repo working tree. Required so the doctor can probe `qa/ios.yml`. Without
   * this the doctor would report green even when the repo has no config and
   * the orchestrator would refuse to dispatch — the exact disconnect users
   * hit when "Run now" fails right after seeing "Setup healthy".
   */
  repoPath: string;
  poolSize: number;
  appiumPortBase: number;
  wdaPortBase: number;
  device: string;
  os?: string;
  /** Test injection: override execFile so doctor.test.ts can stub responses. */
  exec?: typeof exec;
  /** Optional: receive per-step progress while runSetup is working. */
  onProgress?: (p: SetupProgress) => void;
}

const STEP_LABELS: Record<SetupStep, string> = {
  'install-appium': 'Installing Appium',
  'install-xcuitest': 'Installing Appium xcuitest driver',
  'bootstrap-pool': 'Bootstrapping simulator pool',
  'scaffold-config': 'Scaffolding qa/ios.yml',
};

export async function runDoctor(opts: DoctorOpts): Promise<DoctorReport> {
  const run = opts.exec ?? exec;
  const checks: DoctorCheck[] = [];

  checks.push(await checkXcode(run));
  checks.push(await checkSimRuntime(run));
  checks.push(await checkNode(run));
  checks.push(await checkAppium(run));
  checks.push(await checkXcuitestDriver(run));
  checks.push(checkPoolSlots(opts.poolSize));
  checks.push(checkSetupTimestamp(opts.repoId));
  checks.push(checkRepoConfig(opts.repoPath));

  const overall: CheckLevel = checks.some((c) => c.level === 'red')
    ? 'red'
    : checks.some((c) => c.level === 'yellow')
      ? 'yellow'
      : 'green';

  return {
    overall,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Run only the steps needed to bring red checks to green. Idempotent: each
 * install is gated on a "still missing?" probe so re-clicking doesn't error.
 *
 * Each install captures stdout/stderr; failures are folded into the returned
 * report so the panel shows what went wrong instead of silently saying
 * "Setup completed". `setup_at` is only written when every critical step
 * succeeded.
 */
export async function runSetup(opts: DoctorOpts): Promise<DoctorReport> {
  const run = opts.exec ?? exec;
  const errors: { step: string; error: string }[] = [];
  const emit = (step: SetupStep, status: SetupProgress['status']): void => {
    opts.onProgress?.({ step, label: STEP_LABELS[step], status });
  };

  // 1. Appium itself.
  if ((await checkAppium(run)).level !== 'green') {
    emit('install-appium', 'started');
    const r = await runStep(run, 'npm', ['install', '-g', 'appium']);
    if (!r.ok) {
      errors.push({
        step: 'install Appium',
        error: formatInstallFailure(
          '`npm install -g appium` failed',
          r.error ?? 'unknown error',
          r.output,
        ),
      });
      emit('install-appium', 'failed');
    } else {
      emit('install-appium', 'completed');
    }
  }

  // 2. xcuitest driver. tryInstallXcuitest does its own pre-check and treats
  // post-install verification (not exit code) as the source of truth, so an
  // "already installed" error from a stale doctor report doesn't fail setup.
  if ((await checkXcuitestDriver(run)).level !== 'green') {
    emit('install-xcuitest', 'started');
    const installed = await tryInstallXcuitest(run);
    if (installed.ok) {
      emit('install-xcuitest', 'completed');
    } else {
      errors.push({ step: 'install xcuitest driver', error: installed.error });
      emit('install-xcuitest', 'failed');
    }
  }

  // 3. Configure qa/ios.yml. The goal is one-click setup: scan the repo
  // for an Xcode project, ask xcodebuild for the bundle id + product
  // path, and fill in qa/ios.yml so the user never has to know what
  // those values are. If detection fails (no project, xcodebuild
  // unavailable, ambiguous schemes) we fall back to scaffolding an empty
  // file so the inline form on the QA Pilot screen has something to
  // edit. Detection NEVER overwrites fields that are already filled in.
  emit('scaffold-config', 'started');
  try {
    scaffoldRepoConfig(opts.repoPath);
    let cfg = loadIosConfig(opts.repoPath);
    const detected = await detectIosConfig(opts.repoPath, run).catch(() => null);
    if (detected) {
      const patch: IosConfigPatch = {};
      if (!cfg.appPath) patch.appPath = detected.appPath;
      if (!cfg.bundleId) patch.bundleId = detected.bundleId;
      if (Object.keys(patch).length > 0) cfg = saveIosConfig(opts.repoPath, patch);
    }
    // The flow registry needs at least one *.flow.md or the agent
    // refuses to dispatch (IOS_QA_NO_FLOWS). Scaffold a default
    // app-sweep flow that drives the user's test plan when the dir is
    // empty — Run setup is then sufficient to reach a runnable state.
    scaffoldDefaultFlow(opts.repoPath, cfg.flowsDir);
    // Per-project memory file for the iOS QA Pilot agent. Created
    // once, append-only thereafter. Picked up automatically by the
    // orchestrator's qa/*.md inliner.
    scaffoldMemoryFile(opts.repoPath);
    emit('scaffold-config', 'completed');
  } catch (e) {
    errors.push({ step: 'configure qa/ios.yml', error: errorMessage(e) });
    emit('scaffold-config', 'failed');
  }

  // 4. Bootstrap pool slots (clones simulators if missing).
  emit('bootstrap-pool', 'started');
  try {
    const bootstrap: BootstrapOpts = {
      size: opts.poolSize,
      appiumPortBase: opts.appiumPortBase,
      wdaPortBase: opts.wdaPortBase,
      device: opts.device,
      os: opts.os,
    };
    await bootstrapPool(bootstrap);
    await keepBooted();
    emit('bootstrap-pool', 'completed');
  } catch (e) {
    errors.push({ step: 'bootstrap simulator pool', error: errorMessage(e) });
    emit('bootstrap-pool', 'failed');
  }

  // 5. Only stamp setup_at when every required step landed. setup_at means
  // "environment is ready" — the repo_config check is independent and
  // stays red until the user fills in qa/ios.yml.
  if (errors.length === 0) {
    setSetupAt(opts.repoId, new Date().toISOString());
  }

  const report = await runDoctor(opts);
  if (errors.length > 0) {
    report.overall = 'red';
    report.checks.push({
      id: 'setup_errors',
      label: 'Setup errors',
      level: 'red',
      detail: errors.map((e) => `${e.step}: ${truncate(e.error, 800)}`).join(' · '),
      remediation:
        'Open a terminal and run the failed command manually so you can see the full output. Common fixes: `appium driver uninstall xcuitest && appium driver install xcuitest`, or check that `which appium` matches the binary used by Obelisk.',
    });
  }
  return report;
}

/* ---------- individual checks ---------- */

async function checkXcode(run: typeof exec): Promise<DoctorCheck> {
  try {
    const { stdout } = await run('xcode-select', ['-p']);
    return {
      id: 'xcode',
      label: 'Xcode command-line tools',
      level: 'green',
      detail: stdout.trim(),
    };
  } catch {
    return {
      id: 'xcode',
      label: 'Xcode command-line tools',
      level: 'red',
      detail: '`xcode-select -p` failed; Xcode CLT not installed.',
      remediation: 'xcode-select --install',
    };
  }
}

async function checkSimRuntime(run: typeof exec): Promise<DoctorCheck> {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'runtimes', '-j']);
    const parsed = JSON.parse(stdout) as {
      runtimes: { identifier: string; isAvailable: boolean }[];
    };
    const ios = parsed.runtimes.filter(
      (r) => r.isAvailable && r.identifier.includes('SimRuntime.iOS-'),
    );
    if (ios.length === 0) {
      return {
        id: 'sim_runtime',
        label: 'iOS Simulator runtime',
        level: 'red',
        detail: 'No iOS simulator runtimes are installed.',
        remediation: 'Open Xcode → Settings → Platforms and install an iOS simulator runtime.',
      };
    }
    return {
      id: 'sim_runtime',
      label: 'iOS Simulator runtime',
      level: 'green',
      detail: `Found ${ios.length} runtime(s): ${ios.map((r) => r.identifier.replace(/^.*iOS-/, 'iOS ')).join(', ')}`,
    };
  } catch {
    return {
      id: 'sim_runtime',
      label: 'iOS Simulator runtime',
      level: 'red',
      detail: '`xcrun simctl list runtimes` failed.',
      remediation: 'Install Xcode and run `xcode-select --install`.',
    };
  }
}

async function checkNode(run: typeof exec): Promise<DoctorCheck> {
  try {
    const { stdout } = await run('node', ['--version']);
    return {
      id: 'node',
      label: 'Node.js (for Appium)',
      level: 'green',
      detail: stdout.trim(),
    };
  } catch {
    return {
      id: 'node',
      label: 'Node.js (for Appium)',
      level: 'red',
      detail: '`node --version` failed.',
      remediation: 'Install Node 18+ from https://nodejs.org or via nvm.',
    };
  }
}

async function checkAppium(run: typeof exec): Promise<DoctorCheck> {
  try {
    const { stdout } = await run('appium', ['--version']);
    return {
      id: 'appium',
      label: 'Appium',
      level: 'green',
      detail: stdout.trim(),
    };
  } catch {
    return {
      id: 'appium',
      label: 'Appium',
      level: 'red',
      detail: '`appium --version` failed.',
      remediation: 'npm install -g appium',
    };
  }
}

async function checkXcuitestDriver(run: typeof exec): Promise<DoctorCheck> {
  try {
    const drivers = await listInstalledDrivers(run);
    if (!drivers.has('xcuitest')) {
      return {
        id: 'xcuitest',
        label: 'Appium xcuitest driver',
        level: 'red',
        detail: 'xcuitest driver not installed.',
        remediation: 'appium driver install xcuitest',
      };
    }
    return {
      id: 'xcuitest',
      label: 'Appium xcuitest driver',
      level: 'green',
      detail: 'xcuitest driver installed.',
    };
  } catch {
    return {
      id: 'xcuitest',
      label: 'Appium xcuitest driver',
      level: 'red',
      detail: '`appium driver list` failed.',
      remediation: 'Install Appium first, then `appium driver install xcuitest`.',
    };
  }
}

// `appium driver list --installed` writes its human-readable list through
// npmlog to stderr (and the routing has drifted across 2.x point releases),
// so parsing stdout alone is fragile. `--json` emits a structured object
// keyed by driver name to stdout — that's our authoritative answer. The
// regex fallback is for older or non-conforming Appium builds: combine
// stdout + stderr, strip ANSI CSI codes, match `name@version` lines.
async function listInstalledDrivers(run: typeof exec): Promise<Set<string>> {
  const { stdout, stderr } = await run('appium', ['driver', 'list', '--installed', '--json']);
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed));
    }
  } catch {
    // fall through to regex fallback
  }
  const cleaned = stripAnsi(`${stdout}\n${stderr}`);
  const names = new Set<string>();
  // Match `name@version` anywhere with a word boundary in front so we catch
  // both `xcuitest@5.0.0` (line-leading) and `- xcuitest@5.0.0` (Appium's
  // bullet-list format).
  for (const m of cleaned.matchAll(/\b([a-z][a-z0-9_-]*)@\d/gi)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

function stripAnsi(s: string): string {
  // CSI sequences only — covers npmlog/chalk output from Appium 2.x. The
  // \x1b control character is the whole point of the regex, so silence
  // the lint rule for this one expression.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function checkPoolSlots(expected: number): DoctorCheck {
  const slots = listSimSlots();
  if (slots.length === 0) {
    return {
      id: 'pool_slots',
      label: 'Simulator pool',
      level: 'red',
      detail: 'No simulator slots cloned yet.',
      remediation: 'Click "Run setup" to clone the pool.',
    };
  }
  if (slots.length < expected) {
    return {
      id: 'pool_slots',
      label: 'Simulator pool',
      level: 'yellow',
      detail: `Pool has ${slots.length} slots, expected ${expected}.`,
      remediation: 'Click "Run setup" to top up the pool.',
    };
  }
  return {
    id: 'pool_slots',
    label: 'Simulator pool',
    level: 'green',
    detail: `${slots.length} slots ready (${slots.map((s) => `slot ${s.slotIndex}`).join(', ')}).`,
  };
}

function checkRepoConfig(repoPath: string): DoctorCheck {
  const ymlPath = join(repoPath, 'qa', 'ios.yml');
  if (!existsSync(ymlPath)) {
    return {
      id: 'repo_config',
      label: 'Repo config (qa/ios.yml)',
      level: 'red',
      detail:
        '`qa/ios.yml` is missing — the agent needs `app_path` and `bundle_id` to launch the simulator app.',
      remediation:
        'Click "Run setup" to scaffold a starter qa/ios.yml, then open the file and fill in app_path + bundle_id.',
    };
  }
  const cfg = loadIosConfig(repoPath);
  if (!isConfigured(cfg)) {
    const missing: string[] = [];
    if (!cfg.appPath) missing.push('app_path');
    if (!cfg.bundleId) missing.push('bundle_id');
    return {
      id: 'repo_config',
      label: 'Repo config (qa/ios.yml)',
      level: 'red',
      detail: `qa/ios.yml is present but missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      remediation: `Open qa/ios.yml in the repo and set ${missing.map((m) => `\`${m}\``).join(' and ')}, then click "Re-check".`,
    };
  }
  return {
    id: 'repo_config',
    label: 'Repo config (qa/ios.yml)',
    level: 'green',
    detail: `app_path=${cfg.appPath} · bundle_id=${cfg.bundleId}`,
  };
}

/**
 * Write a default `<flowsDir>/app-sweep.flow.md` if no `*.flow.md` files
 * are present yet. Returns true when a new file was written. Idempotent:
 * once any flow file exists (even unrelated to this scaffold), the
 * function does nothing — it never overwrites the user's edits or adds
 * a duplicate after the user has authored their own flows.
 */
export function scaffoldDefaultFlow(repoPath: string, flowsDir: string): boolean {
  const dir = join(repoPath, flowsDir);
  let existingFlows = false;
  try {
    if (existsSync(dir)) {
      existingFlows = readdirSync(dir).some((f) => f.endsWith('.flow.md'));
    }
  } catch {
    existingFlows = false;
  }
  if (existingFlows) return false;
  return scaffoldFile(join(dir, 'app-sweep.flow.md'), DEFAULT_FLOW_BODY);
}

const DEFAULT_FLOW_BODY = [
  '---',
  'title: App sweep',
  'priority: P0',
  '---',
  '',
  '# Steps',
  '',
  '1. Launch the app from a clean state (kill prior process if running).',
  '2. Walk through every case listed in the assigned test plan.',
  '3. For each case: follow the **Repro** steps and verify the **Expected** outcome.',
  '4. Capture a screenshot for any case that fails or behaves unexpectedly.',
  '',
  '# Notes',
  '',
  '- Each test plan case is a checkpoint — log a finding for any divergence.',
  '- Edit this file to split into focused per-feature flows once you know',
  '  which surfaces of the app you want to sweep separately.',
  '',
].join('\n');

/**
 * Write a starter `qa/ios.yml` if one doesn't already exist. The empty
 * quoted strings keep the YAML syntactically valid while making it
 * obvious which fields the user must fill in. The doctor stays red
 * (isConfigured returns false) until the user replaces the empties.
 */
export function scaffoldRepoConfig(repoPath: string): boolean {
  return scaffoldFile(join(repoPath, 'qa', 'ios.yml'), STARTER_IOS_YML);
}

const STARTER_IOS_YML = [
  '# iOS QA Pilot configuration. Edit the empty fields below, then',
  '# click "Re-check" on the iOS QA Pilot screen.',
  '',
  '# Path to your built .app bundle, relative to the repo root.',
  '# Example: build/Debug-iphonesimulator/MyApp.app',
  'app_path: ""',
  '',
  "# CFBundleIdentifier from your app's Info.plist.",
  '# Example: com.example.myapp',
  'bundle_id: ""',
  '',
  '# Optional — defaults below are sensible for most projects.',
  '# simulator_device: "iPhone 15"',
  '# max_parallel: 2',
  '# flows_dir: qa/ios-flows',
  '',
].join('\n');

function checkSetupTimestamp(repoId: string): DoctorCheck {
  const at = getSetupAt(repoId);
  if (!at) {
    return {
      id: 'setup_done',
      label: 'Setup completed',
      level: 'red',
      detail: 'Setup has not been run for this repo.',
      remediation: 'Click "Run setup" — it is idempotent.',
    };
  }
  return {
    id: 'setup_done',
    label: 'Setup completed',
    level: 'green',
    detail: `Last run at ${at}.`,
  };
}

interface StepResult {
  ok: boolean;
  /** stdout + stderr concatenated, captured in both success and failure paths. */
  output: string;
  /** Set when `ok === false`. */
  error?: string;
}

async function runStep(run: typeof exec, cmd: string, args: string[]): Promise<StepResult> {
  try {
    const r = await run(cmd, args, { maxBuffer: SETUP_MAX_BUFFER });
    return { ok: true, output: combineOutput(r.stdout, r.stderr) };
  } catch (e) {
    const withStreams = e as { stdout?: string; stderr?: string };
    return {
      ok: false,
      error: errorMessage(e),
      output: combineOutput(withStreams.stdout ?? '', withStreams.stderr ?? ''),
    };
  }
}

/**
 * Install the xcuitest driver, but treat post-install verification as the
 * source of truth — not the install command's exit code. This collapses
 * three real-world scenarios into one happy path:
 *
 *   1. Driver was actually already installed but the doctor's pre-check
 *      misfired (e.g. older Appium routing list output to stderr). Install
 *      errors with "already installed", post-check shows it → success.
 *   2. Install exits 0 but the driver isn't registered yet (partial-install
 *      state, mixed appium versions on PATH). One clean uninstall +
 *      reinstall pass usually resolves this.
 *   3. Install exits 0 and driver is registered. Trivial.
 *
 * Only when post-check still shows the driver missing do we surface an
 * error — and we attach `which appium` / `--version` / `APPIUM_HOME` so the
 * user can diagnose the most common cause (the doctor and the install path
 * looking at different driver registries).
 */
async function tryInstallXcuitest(
  run: typeof exec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Pre-check: driver may already be present even when an earlier doctor
  // report claimed otherwise (stale report, JSON-vs-stdout drift, etc.).
  if (await isXcuitestPresent(run)) return { ok: true };

  const first = await runStep(run, 'appium', ['driver', 'install', 'xcuitest']);
  if (await isXcuitestPresent(run)) return { ok: true };

  if (!first.ok) {
    const diagnostics = await formatAppiumDiagnostics(run);
    return {
      ok: false,
      error: formatInstallFailure(
        '`appium driver install xcuitest` failed',
        first.error ?? 'unknown error',
        first.output,
        diagnostics,
      ),
    };
  }

  // Install exited 0 but the driver still isn't visible. Try a clean
  // reinstall. We ignore uninstall errors because the driver may simply
  // not be in any registry appium can see.
  await runStep(run, 'appium', ['driver', 'uninstall', 'xcuitest']);
  const second = await runStep(run, 'appium', ['driver', 'install', 'xcuitest']);
  if (await isXcuitestPresent(run)) return { ok: true };

  const diagnostics = await formatAppiumDiagnostics(run);
  return {
    ok: false,
    error: formatInstallFailure(
      second.ok
        ? '`appium driver install xcuitest` exited 0 but xcuitest is still missing from `appium driver list --installed`'
        : '`appium driver install xcuitest` failed on retry',
      second.error ?? 'install reported success but driver not registered',
      second.output || first.output,
      diagnostics,
    ),
  };
}

async function isXcuitestPresent(run: typeof exec): Promise<boolean> {
  try {
    return (await listInstalledDrivers(run)).has('xcuitest');
  } catch {
    return false;
  }
}

async function formatAppiumDiagnostics(run: typeof exec): Promise<string> {
  const [whichAppium, appiumVersion] = await Promise.all([
    captureOutput(run, 'which', ['appium']),
    captureOutput(run, 'appium', ['--version']),
  ]);
  const home = process.env.APPIUM_HOME ?? '<unset>';
  return [
    `which appium: ${whichAppium || '<not found>'}`,
    `appium --version: ${appiumVersion || '<unknown>'}`,
    `APPIUM_HOME: ${home}`,
  ].join(' | ');
}

async function captureOutput(run: typeof exec, cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args);
    return stdout.trim();
  } catch {
    return '';
  }
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

function formatInstallFailure(
  headline: string,
  error: string,
  output: string,
  diagnostics?: string,
): string {
  const tail = output ? ` — output: ${truncate(output, 400)}` : '';
  const diag = diagnostics ? ` — diagnostics: ${diagnostics}` : '';
  return `${headline}: ${error}${tail}${diag}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    // execFile rejections include stderr in the message; prefer that when
    // available so the user sees the real install error, not just "exit 1".
    const withStderr = e as Error & { stderr?: string };
    if (typeof withStderr.stderr === 'string' && withStderr.stderr.length > 0) {
      return withStderr.stderr.trim();
    }
    return e.message;
  }
  return String(e);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
