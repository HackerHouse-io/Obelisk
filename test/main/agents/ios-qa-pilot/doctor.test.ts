import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import { runDoctor } from '../../../../src/main/agents/ios-qa-pilot/doctor';
import { upsertSimSlot, setSetupAt } from '../../../../src/main/db/qa-flows';

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
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4', isAvailable: true },
  ],
});

describe('runDoctor', () => {
  it('returns red when prerequisites are missing', async () => {
    const fakeExec = makeFakeExec({
      'xcode-select -p': new Error('no xcode'),
      'xcrun simctl list runtimes -j': new Error('no xcrun'),
      'node --version': new Error('no node'),
      'appium --version': new Error('no appium'),
      'appium driver list --installed': new Error('no driver'),
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
      'appium driver list --installed': { stdout: 'xcuitest@5', stderr: '' },
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
      'appium driver list --installed': { stdout: 'xcuitest@5', stderr: '' },
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

  it('flags missing xcuitest driver as red with the right remediation', async () => {
    setSetupAt(repoId, new Date().toISOString());
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
    const fakeExec = makeFakeExec({
      'xcode-select -p': { stdout: '/Applications/Xcode.app', stderr: '' },
      'xcrun simctl list runtimes -j': { stdout: RUNTIMES_OK, stderr: '' },
      'node --version': { stdout: 'v20.0.0', stderr: '' },
      'appium --version': { stdout: '2.0.0', stderr: '' },
      'appium driver list --installed': { stdout: '(no drivers)', stderr: '' },
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
});
