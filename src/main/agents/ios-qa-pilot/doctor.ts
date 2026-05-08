import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootstrapPool, keepBooted, type BootstrapOpts } from './sim-pool';
import { getSetupAt, listSimSlots, setSetupAt } from '../../db/qa-flows';

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

export type SetupStep = 'install-appium' | 'install-xcuitest' | 'bootstrap-pool';

export interface SetupProgress {
  step: SetupStep;
  label: string;
  status: 'started' | 'completed' | 'failed';
}

export interface DoctorOpts {
  repoId: string;
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
      errors.push({ step: 'install Appium', error: r.error });
      emit('install-appium', 'failed');
    } else {
      emit('install-appium', 'completed');
    }
  }

  // 2. xcuitest driver — only install if not already present (the CLI errors
  // if you ask it to install a driver that's already installed).
  if ((await checkXcuitestDriver(run)).level !== 'green') {
    emit('install-xcuitest', 'started');
    const r = await runStep(run, 'appium', ['driver', 'install', 'xcuitest']);
    if (!r.ok) {
      errors.push({ step: 'install xcuitest driver', error: r.error });
      emit('install-xcuitest', 'failed');
    } else {
      emit('install-xcuitest', 'completed');
    }
  }

  // 3. Bootstrap pool slots (clones simulators if missing).
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

  // 4. Only stamp setup_at when every required step landed.
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
      detail: errors.map((e) => `${e.step}: ${truncate(e.error, 240)}`).join(' · '),
      remediation:
        'Open the Terminal and run the failed command manually, then click Re-check. If the install needs sudo, run it from a shell with the right permissions.',
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
    const { stdout } = await run('appium', ['driver', 'list', '--installed']);
    if (!/xcuitest/i.test(stdout)) {
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

async function runStep(
  run: typeof exec,
  cmd: string,
  args: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await run(cmd, args, { maxBuffer: SETUP_MAX_BUFFER });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
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
