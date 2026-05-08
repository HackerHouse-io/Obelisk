import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import { runDoctor, runSetup } from '../../../../src/main/agents/ios-qa-pilot/doctor';
import { getSetupAt, upsertSimSlot, setSetupAt } from '../../../../src/main/db/qa-flows';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-doctor-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/ios',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

interface ExecResponse {
  stdout: string;
  stderr: string;
}

function makeFakeExec(
  responses: Record<string, ExecResponse | Error>,
): (cmd: string, args: string[]) => Promise<ExecResponse> {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = responses[key];
    if (r === undefined) throw new Error(`unmocked: ${key}`);
    if (r instanceof Error) throw r;
    return r;
  };
}

const RUNTIMES_OK = JSON.stringify({
  runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4', isAvailable: true }],
});

const DRIVERS_WITH_XCUITEST = JSON.stringify({
  xcuitest: { version: '5.0.0', automationName: 'XCUITest' },
});
const DRIVERS_EMPTY = '{}';

describe('runDoctor', () => {
  it('returns red when prerequisites are missing', async () => {
    const fakeExec = makeFakeExec({
      'xcode-select -p': new Error('no xcode'),
      'xcrun simctl list runtimes -j': new Error('no xcrun'),
      'node --version': new Error('no node'),
      'appium --version': new Error('no appium'),
      'appium driver list --installed --json': new Error('no driver'),
    });
    const report = await runDoctor({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });
    expect(report.overall).toBe('red');
    const xcode = report.checks.find((c) => c.id === 'xcode')!;
    expect(xcode.level).toBe('red');
    expect(xcode.remediation).toContain('xcode-select');
  });

  it('returns yellow when pool is partially populated', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    setSetupAt(repoId, new Date().toISOString());
    const fakeExec = makeFakeExec({
      'xcode-select -p': { stdout: '/Applications/Xcode.app', stderr: '' },
      'xcrun simctl list runtimes -j': { stdout: RUNTIMES_OK, stderr: '' },
      'node --version': { stdout: 'v20.0.0', stderr: '' },
      'appium --version': { stdout: '2.0.0', stderr: '' },
      'appium driver list --installed --json': { stdout: DRIVERS_WITH_XCUITEST, stderr: '' },
    });
    const report = await runDoctor({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });
    expect(report.overall).toBe('yellow');
    const slots = report.checks.find((c) => c.id === 'pool_slots')!;
    expect(slots.level).toBe('yellow');
  });

  it('returns green when everything is in place', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    setSetupAt(repoId, new Date().toISOString());
    const fakeExec = makeFakeExec({
      'xcode-select -p': { stdout: '/Applications/Xcode.app', stderr: '' },
      'xcrun simctl list runtimes -j': { stdout: RUNTIMES_OK, stderr: '' },
      'node --version': { stdout: 'v20.0.0', stderr: '' },
      'appium --version': { stdout: '2.0.0', stderr: '' },
      'appium driver list --installed --json': { stdout: DRIVERS_WITH_XCUITEST, stderr: '' },
    });
    const report = await runDoctor({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });
    expect(report.overall).toBe('green');
    expect(report.checks.every((c) => c.level === 'green')).toBe(true);
  });

  it('surfaces install failures from runSetup instead of marking setup_at', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    // listInstalledDrivers is called multiple times during runSetup
    // (pre-install probe, post-install verify, and finally the doctor
    // re-run). All returns must show xcuitest absent so the red bubbles up.
    const calls: string[] = [];
    const installFailure = Object.assign(new Error('exit 1'), {
      stderr: 'EACCES: permission denied while writing to /usr/local/lib',
    });
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json')
        return { stdout: DRIVERS_EMPTY, stderr: '' };
      if (key === 'appium driver install xcuitest') throw installFailure;
      if (key === 'appium driver uninstall xcuitest') return { stdout: '', stderr: '' };
      if (key === 'npm install -g appium') return { stdout: '', stderr: '' };
      if (key === 'which appium') return { stdout: '/usr/local/bin/appium', stderr: '' };
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('red');
    expect(getSetupAt(repoId)).toBeNull(); // gated on success — must NOT be stamped
    const errs = report.checks.find((c) => c.id === 'setup_errors')!;
    expect(errs).toBeTruthy();
    expect(errs.level).toBe('red');
    expect(errs.detail).toContain('install xcuitest driver');
    expect(errs.detail).toContain('EACCES'); // stderr surfaced, not just "exit 1"
    expect(calls).toContain('appium driver install xcuitest');
  });

  it('runSetup is idempotent — skips installs that are already green', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    const calls: string[] = [];
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json')
        return { stdout: DRIVERS_WITH_XCUITEST, stderr: '' };
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('green');
    expect(getSetupAt(repoId)).not.toBeNull();
    // Crucial: did NOT re-run the install commands, since they were already green.
    expect(calls).not.toContain('npm install -g appium');
    expect(calls).not.toContain('appium driver install xcuitest');
  });

  it('flags missing xcuitest driver as red with the right remediation', async () => {
    setSetupAt(repoId, new Date().toISOString());
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    const fakeExec = makeFakeExec({
      'xcode-select -p': { stdout: '/Applications/Xcode.app', stderr: '' },
      'xcrun simctl list runtimes -j': { stdout: RUNTIMES_OK, stderr: '' },
      'node --version': { stdout: 'v20.0.0', stderr: '' },
      'appium --version': { stdout: '2.0.0', stderr: '' },
      'appium driver list --installed --json': { stdout: DRIVERS_EMPTY, stderr: '' },
    });
    const report = await runDoctor({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });
    expect(report.overall).toBe('red');
    const driver = report.checks.find((c) => c.id === 'xcuitest')!;
    expect(driver.level).toBe('red');
    expect(driver.remediation).toContain('appium driver install xcuitest');
  });

  it('survives "already installed" error when post-check shows the driver — the actual bug', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });

    // Simulates the production bug: `driver list --installed --json` returns
    // `{}` initially (mirroring older Appium routing the list to stderr after
    // a partial-state run), so the pre-check thinks xcuitest is missing.
    // `appium driver install xcuitest` errors out with "already installed".
    // After the install attempt the next list call now reflects truth and
    // returns xcuitest. Setup must succeed because the post-check is the
    // source of truth, not the install command's exit code.
    let installAttempted = false;
    const installError = Object.assign(new Error('exit 1'), {
      stderr: 'A driver named "xcuitest" is already installed. Did you mean to update?',
    });
    const calls: string[] = [];
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json') {
        return {
          stdout: installAttempted ? DRIVERS_WITH_XCUITEST : DRIVERS_EMPTY,
          stderr: '',
        };
      }
      if (key === 'appium driver install xcuitest') {
        installAttempted = true;
        throw installError;
      }
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('green');
    expect(getSetupAt(repoId)).not.toBeNull();
    expect(report.checks.find((c) => c.id === 'setup_errors')).toBeUndefined();
    // We did try install, but did NOT escalate to uninstall+reinstall.
    expect(calls).toContain('appium driver install xcuitest');
    expect(calls).not.toContain('appium driver uninstall xcuitest');
  });

  it('falls back to combined-stream regex when --json output is unparseable', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    const calls: string[] = [];
    // Some Appium builds ignore --json and dump human output. The regex
    // fallback strips ANSI codes and reads `xcuitest@5.0.0` from stderr.
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json') {
        return {
          stdout: '',
          stderr: '[32m✔[39m Listing installed drivers\n- xcuitest@5.0.0 [installed (npm)]',
        };
      }
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('green');
    expect(report.checks.find((c) => c.id === 'xcuitest')!.level).toBe('green');
    // Regex picked up xcuitest from the human-readable stderr — no install needed.
    expect(calls).not.toContain('appium driver install xcuitest');
  });

  it('runs the install when registry is genuinely empty', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    let installAttempted = false;
    const calls: string[] = [];
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json') {
        return {
          stdout: installAttempted ? DRIVERS_WITH_XCUITEST : DRIVERS_EMPTY,
          stderr: '',
        };
      }
      if (key === 'appium driver install xcuitest') {
        installAttempted = true;
        return { stdout: 'installed xcuitest@5.0.0', stderr: '' };
      }
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('green');
    expect(getSetupAt(repoId)).not.toBeNull();
    expect(calls).toContain('appium driver install xcuitest');
  });

  it('attaches Appium diagnostics to real failures', async () => {
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    const installError = Object.assign(new Error('exit 1'), {
      stderr: 'EACCES: permission denied while writing to /usr/local/lib',
    });
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j') return { stdout: RUNTIMES_OK, stderr: '' };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.5.0', stderr: '' };
      if (key === 'appium driver list --installed --json')
        return { stdout: DRIVERS_EMPTY, stderr: '' };
      if (key === 'appium driver install xcuitest') throw installError;
      if (key === 'which appium') return { stdout: '/opt/homebrew/bin/appium', stderr: '' };
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    expect(report.overall).toBe('red');
    expect(getSetupAt(repoId)).toBeNull();
    const errs = report.checks.find((c) => c.id === 'setup_errors')!;
    expect(errs).toBeTruthy();
    expect(errs.detail).toContain('EACCES'); // root error preserved
    expect(errs.detail).toContain('which appium: /opt/homebrew/bin/appium');
    expect(errs.detail).toContain('appium --version: 2.5.0');
    expect(errs.detail).toContain('APPIUM_HOME:');
  });
});
