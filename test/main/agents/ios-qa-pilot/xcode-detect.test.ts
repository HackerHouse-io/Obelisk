import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApp,
  detectIosConfig,
  findXcodeProject,
  type XcodeProjectRef,
} from '../../../../src/main/agents/ios-qa-pilot/xcode-detect';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-xcode-detect-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeResp {
  stdout: string;
  stderr: string;
}

function makeFakeExec(
  responses: Record<string, FakeResp | Error>,
): (cmd: string, args: string[]) => Promise<FakeResp> {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = responses[key];
    if (r === undefined) throw new Error(`unmocked: ${key}`);
    if (r instanceof Error) throw r;
    return r;
  };
}

describe('findXcodeProject', () => {
  it('returns null when no project exists', () => {
    expect(findXcodeProject(tmp)).toBeNull();
  });

  it('finds a top-level .xcodeproj', () => {
    mkdirSync(join(tmp, 'MyApp.xcodeproj'));
    const ref = findXcodeProject(tmp)!;
    expect(ref.type).toBe('project');
    expect(ref.name).toBe('MyApp');
  });

  it('prefers a workspace over a sibling project', () => {
    mkdirSync(join(tmp, 'MyApp.xcodeproj'));
    mkdirSync(join(tmp, 'MyApp.xcworkspace'));
    const ref = findXcodeProject(tmp)!;
    expect(ref.type).toBe('workspace');
  });

  it('walks one level deep when the project is in a subdirectory', () => {
    mkdirSync(join(tmp, 'ios'), { recursive: true });
    mkdirSync(join(tmp, 'ios', 'MyApp.xcodeproj'));
    const ref = findXcodeProject(tmp)!;
    expect(ref.name).toBe('MyApp');
    expect(ref.path).toContain(join('ios', 'MyApp.xcodeproj'));
  });

  it('skips obvious build/output directories', () => {
    mkdirSync(join(tmp, 'node_modules', 'some_pkg', 'TheirApp.xcodeproj'), { recursive: true });
    expect(findXcodeProject(tmp)).toBeNull();
  });
});

describe('detectIosConfig', () => {
  it('returns null when no Xcode project is present', async () => {
    const res = await detectIosConfig(tmp, makeFakeExec({}) as never);
    expect(res).toBeNull();
  });

  it('returns the detected bundle id and a repo-relative app_path', async () => {
    mkdirSync(join(tmp, 'MyApp.xcodeproj'));
    const projectArg = join(tmp, 'MyApp.xcodeproj');
    const derivedArg = join(tmp, 'build');

    const fakeExec = makeFakeExec({
      [`xcodebuild -project ${projectArg} -list -json`]: {
        stdout: JSON.stringify({ project: { name: 'MyApp', schemes: ['MyApp', 'MyAppTests'] } }),
        stderr: '',
      },
      [`xcodebuild -project ${projectArg} -scheme MyApp -configuration Debug -sdk iphonesimulator -derivedDataPath ${derivedArg} -showBuildSettings -json`]:
        {
          stdout: JSON.stringify([
            {
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.myapp',
                BUILT_PRODUCTS_DIR: join(derivedArg, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'MyApp.app',
              },
            },
          ]),
          stderr: '',
        },
    });

    const res = (await detectIosConfig(tmp, fakeExec as never))!;
    expect(res.bundleId).toBe('com.example.myapp');
    expect(res.appPath).toBe(
      join('build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app'),
    );
    expect(res.scheme).toBe('MyApp');
    expect(res.project.type).toBe('project');
  });

  it('avoids picking a *Tests scheme when a sensible app scheme exists', async () => {
    mkdirSync(join(tmp, 'Foo.xcodeproj'));
    const projectArg = join(tmp, 'Foo.xcodeproj');
    const derivedArg = join(tmp, 'build');

    const fakeExec = makeFakeExec({
      [`xcodebuild -project ${projectArg} -list -json`]: {
        // Note: project.name is "OtherName" so the exact-name heuristic
        // doesn't match — the test scheme should still be skipped.
        stdout: JSON.stringify({ project: { name: 'OtherName', schemes: ['FooTests', 'FooApp'] } }),
        stderr: '',
      },
      [`xcodebuild -project ${projectArg} -scheme FooApp -configuration Debug -sdk iphonesimulator -derivedDataPath ${derivedArg} -showBuildSettings -json`]:
        {
          stdout: JSON.stringify([
            {
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.foo',
                BUILT_PRODUCTS_DIR: join(derivedArg, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'FooApp.app',
              },
            },
          ]),
          stderr: '',
        },
    });

    const res = (await detectIosConfig(tmp, fakeExec as never))!;
    expect(res.scheme).toBe('FooApp');
    expect(res.bundleId).toBe('com.example.foo');
  });

  it('returns null when xcodebuild fails', async () => {
    mkdirSync(join(tmp, 'MyApp.xcodeproj'));
    const projectArg = join(tmp, 'MyApp.xcodeproj');
    const fakeExec = makeFakeExec({
      [`xcodebuild -project ${projectArg} -list -json`]: new Error('xcodebuild not found'),
    });
    const res = await detectIosConfig(tmp, fakeExec as never);
    expect(res).toBeNull();
  });

  it('uses the workspace path when both a workspace and a project exist', async () => {
    mkdirSync(join(tmp, 'MyApp.xcodeproj'));
    mkdirSync(join(tmp, 'MyApp.xcworkspace'));
    const wsArg = join(tmp, 'MyApp.xcworkspace');
    const derivedArg = join(tmp, 'build');

    const fakeExec = makeFakeExec({
      [`xcodebuild -workspace ${wsArg} -list -json`]: {
        stdout: JSON.stringify({ workspace: { name: 'MyApp', schemes: ['MyApp'] } }),
        stderr: '',
      },
      [`xcodebuild -workspace ${wsArg} -scheme MyApp -configuration Debug -sdk iphonesimulator -derivedDataPath ${derivedArg} -showBuildSettings -json`]:
        {
          stdout: JSON.stringify([
            {
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.ws',
                BUILT_PRODUCTS_DIR: join(derivedArg, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'MyApp.app',
              },
            },
          ]),
          stderr: '',
        },
    });

    const res = (await detectIosConfig(tmp, fakeExec as never))!;
    expect(res.project.type).toBe('workspace');
    expect(res.bundleId).toBe('com.example.ws');
  });
});

describe('buildApp', () => {
  const project: XcodeProjectRef = {
    type: 'project',
    path: '/abs/MyApp.xcodeproj',
    name: 'MyApp',
  };

  it('runs xcodebuild build with the expected args and reports duration', async () => {
    const calls: string[] = [];
    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { stdout: 'BUILD SUCCEEDED', stderr: '' };
    };
    const res = await buildApp(
      { project, scheme: 'MyApp', derivedDataPath: '/abs/build' },
      fakeExec as never,
    );
    expect(res.command).toBe(
      'xcodebuild -project /abs/MyApp.xcodeproj -scheme MyApp -configuration Debug -sdk iphonesimulator -derivedDataPath /abs/build build',
    );
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
  });

  it('throws with a stderr tail when xcodebuild fails', async () => {
    const fakeExec = async (): Promise<{ stdout: string; stderr: string }> => {
      const error = Object.assign(new Error('Command failed: xcodebuild'), {
        stderr: 'xx'.repeat(50) + 'error: cannot find type "Foo" in scope\n',
        stdout: '',
      });
      throw error;
    };
    await expect(
      buildApp({ project, scheme: 'MyApp', derivedDataPath: '/abs/build' }, fakeExec as never),
    ).rejects.toThrow(/cannot find type "Foo" in scope/);
  });

  it('honors workspace projects with -workspace arg', async () => {
    const calls: string[] = [];
    const fakeExec = async (
      _cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args.join(' '));
      return { stdout: '', stderr: '' };
    };
    await buildApp(
      {
        project: { type: 'workspace', path: '/abs/MyApp.xcworkspace', name: 'MyApp' },
        scheme: 'MyApp',
        derivedDataPath: '/abs/build',
      },
      fakeExec as never,
    );
    expect(calls[0]).toContain('-workspace /abs/MyApp.xcworkspace');
    expect(calls[0]).not.toContain('-project');
  });
});

// Bonus: ensure that when detectIosConfig succeeds, the doctor pipeline's
// integration with it still preserves user edits — this is the regression
// guarantee that "Run setup" never clobbers a manually-set field.
import { runSetup } from '../../../../src/main/agents/ios-qa-pilot/doctor';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import { upsertSimSlot } from '../../../../src/main/db/qa-flows';
import { loadIosConfig } from '../../../../src/main/agents/ios-qa-pilot/config';
import { readFileSync } from 'node:fs';

describe('runSetup integration with detectIosConfig', () => {
  let dbTmp: string;
  let repoId: string;

  beforeEach(() => {
    dbTmp = mkdtempSync(join(tmpdir(), 'obelisk-runsetup-detect-'));
    setDbPathForTesting(join(dbTmp, 'obelisk.sqlite'));
    runMigrations();
    const repo = createRepo({
      githubFullName: 'test/ios',
      localPath: dbTmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    repoId = repo.id;
    upsertSimSlot({ slotIndex: 0, udid: 'a', appiumPort: 4723, wdaPort: 8100 });
    upsertSimSlot({ slotIndex: 1, udid: 'b', appiumPort: 4724, wdaPort: 8101 });
  });

  afterEach(() => {
    closeDb();
    rmSync(dbTmp, { recursive: true, force: true });
  });

  it('runSetup auto-fills qa/ios.yml when an Xcode project is detectable', async () => {
    mkdirSync(join(dbTmp, 'MyApp.xcodeproj'));
    const projectArg = join(dbTmp, 'MyApp.xcodeproj');
    const derivedArg = join(dbTmp, 'build');

    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j')
        return {
          stdout: JSON.stringify({
            runtimes: [
              {
                identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
                isAvailable: true,
              },
            ],
          }),
          stderr: '',
        };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json')
        return {
          stdout: JSON.stringify({ xcuitest: { version: '5.0.0' } }),
          stderr: '',
        };
      if (key === `xcodebuild -project ${projectArg} -list -json`)
        return {
          stdout: JSON.stringify({ project: { name: 'MyApp', schemes: ['MyApp'] } }),
          stderr: '',
        };
      if (
        key ===
        `xcodebuild -project ${projectArg} -scheme MyApp -configuration Debug -sdk iphonesimulator -derivedDataPath ${derivedArg} -showBuildSettings -json`
      )
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.detected',
                BUILT_PRODUCTS_DIR: join(derivedArg, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'MyApp.app',
              },
            },
          ]),
          stderr: '',
        };
      throw new Error(`unmocked: ${key}`);
    };

    const report = await runSetup({
      repoId,
      repoPath: dbTmp,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    // Doctor's repo_config row must be green — Run setup did the whole
    // job in one click.
    const cfg = report.checks.find((c) => c.id === 'repo_config')!;
    expect(cfg.level).toBe('green');

    // qa/ios.yml on disk should have the detected values.
    const written = loadIosConfig(dbTmp);
    expect(written.bundleId).toBe('com.example.detected');
    expect(written.appPath).toBe(
      join('build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app'),
    );

    // Sanity: file actually exists at qa/ios.yml.
    const raw = readFileSync(join(dbTmp, 'qa', 'ios.yml'), 'utf8');
    expect(raw).toContain('com.example.detected');
  });

  it('does not overwrite manual app_path/bundle_id edits', async () => {
    mkdirSync(join(dbTmp, 'MyApp.xcodeproj'));
    mkdirSync(join(dbTmp, 'qa'), { recursive: true });
    writeFileSync(
      join(dbTmp, 'qa', 'ios.yml'),
      'app_path: build/Custom.app\nbundle_id: com.user.manual\n',
      'utf8',
    );
    const projectArg = join(dbTmp, 'MyApp.xcodeproj');
    const derivedArg = join(dbTmp, 'build');

    const fakeExec = async (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'xcode-select -p') return { stdout: '/Applications/Xcode.app', stderr: '' };
      if (key === 'xcrun simctl list runtimes -j')
        return {
          stdout: JSON.stringify({
            runtimes: [
              {
                identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
                isAvailable: true,
              },
            ],
          }),
          stderr: '',
        };
      if (key === 'node --version') return { stdout: 'v20.0.0', stderr: '' };
      if (key === 'appium --version') return { stdout: '2.0.0', stderr: '' };
      if (key === 'appium driver list --installed --json')
        return {
          stdout: JSON.stringify({ xcuitest: { version: '5.0.0' } }),
          stderr: '',
        };
      if (key === `xcodebuild -project ${projectArg} -list -json`)
        return {
          stdout: JSON.stringify({ project: { name: 'MyApp', schemes: ['MyApp'] } }),
          stderr: '',
        };
      if (
        key ===
        `xcodebuild -project ${projectArg} -scheme MyApp -configuration Debug -sdk iphonesimulator -derivedDataPath ${derivedArg} -showBuildSettings -json`
      )
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.detected',
                BUILT_PRODUCTS_DIR: join(derivedArg, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'MyApp.app',
              },
            },
          ]),
          stderr: '',
        };
      throw new Error(`unmocked: ${key}`);
    };

    await runSetup({
      repoId,
      repoPath: dbTmp,
      poolSize: 2,
      appiumPortBase: 4723,
      wdaPortBase: 8100,
      device: 'iPhone 15',
      exec: fakeExec as never,
    });

    // Manual edits preserved verbatim.
    const written = loadIosConfig(dbTmp);
    expect(written.bundleId).toBe('com.user.manual');
    expect(written.appPath).toBe('build/Custom.app');
  });
});
