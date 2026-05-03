import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootstrapPool, keepBooted, type BootstrapOpts } from './sim-pool';
import { getSetupAt, listSimSlots, setSetupAt } from '../../db/qa-flows';

const exec = promisify(execFile);

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

export interface DoctorOpts {
  repoId: string;
  poolSize: number;
  appiumPortBase: number;
  wdaPortBase: number;
  device: string;
  os?: string;
  /** Test injection: override execFile so doctor.test.ts can stub responses. */
  exec?: typeof exec;
}

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
 * Run only the steps needed to bring red checks to green. Idempotent.
 */
export async function runSetup(opts: DoctorOpts): Promise<DoctorReport> {
  // 1. Make sure Appium + xcuitest are installed (best-effort).
  await safeRun(opts.exec ?? exec, 'npm', ['install', '-g', 'appium']);
  await safeRun(opts.exec ?? exec, 'appium', ['driver', 'install', 'xcuitest']);

  // 2. Bootstrap pool slots (clones simulators if missing).
  const bootstrap: BootstrapOpts = {
    size: opts.poolSize,
    appiumPortBase: opts.appiumPortBase,
    wdaPortBase: opts.wdaPortBase,
    device: opts.device,
    os: opts.os,
  };
  await bootstrapPool(bootstrap);
  await keepBooted();

  // 3. Mark this repo as set up.
  setSetupAt(opts.repoId, new Date().toISOString());

  return runDoctor(opts);
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

async function safeRun(run: typeof exec, cmd: string, args: string[]): Promise<void> {
  try {
    await run(cmd, args);
  } catch {
    // Best-effort install — fail soft so the report can show the user what's missing.
  }
}
