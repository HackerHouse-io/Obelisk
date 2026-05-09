import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isConfigured,
  loadIosConfig,
  saveIosConfig,
} from '../../../../src/main/agents/ios-qa-pilot/config';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-iosconfig-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('saveIosConfig', () => {
  it('creates qa/ios.yml when missing and writes the patched fields', () => {
    const merged = saveIosConfig(tmp, {
      appPath: 'build/Debug-iphonesimulator/MyApp.app',
      bundleId: 'com.example.myapp',
    });
    expect(merged.appPath).toBe('build/Debug-iphonesimulator/MyApp.app');
    expect(merged.bundleId).toBe('com.example.myapp');

    const onDisk = readFileSync(join(tmp, 'qa', 'ios.yml'), 'utf8');
    expect(onDisk).toContain('app_path: build/Debug-iphonesimulator/MyApp.app');
    expect(onDisk).toContain('bundle_id: com.example.myapp');

    // Round-trips through loadIosConfig, so the file is syntactically valid
    // for our parser (which is what selectTask reads at runtime).
    const reloaded = loadIosConfig(tmp);
    expect(isConfigured(reloaded)).toBe(true);
    expect(reloaded.appPath).toBe('build/Debug-iphonesimulator/MyApp.app');
    expect(reloaded.bundleId).toBe('com.example.myapp');
  });

  it('preserves untouched fields when patching just one key', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    writeFileSync(
      join(tmp, 'qa', 'ios.yml'),
      'app_path: build/A.app\nbundle_id: com.a.first\nsimulator_device: iPhone 14\nmax_parallel: 4\n',
      'utf8',
    );
    saveIosConfig(tmp, { bundleId: 'com.b.second' });
    const reloaded = loadIosConfig(tmp);
    // Patched.
    expect(reloaded.bundleId).toBe('com.b.second');
    // Preserved.
    expect(reloaded.appPath).toBe('build/A.app');
    expect(reloaded.simulatorDevice).toBe('iPhone 14');
    expect(reloaded.maxParallel).toBe(4);
  });

  it('quotes values that contain spaces', () => {
    saveIosConfig(tmp, {
      appPath: 'build/Debug iphonesimulator/MyApp.app', // intentional space
      bundleId: 'com.example.myapp',
      simulatorDevice: 'iPhone 15 Pro',
    });
    const onDisk = readFileSync(join(tmp, 'qa', 'ios.yml'), 'utf8');
    expect(onDisk).toContain('app_path: "build/Debug iphonesimulator/MyApp.app"');
    expect(onDisk).toContain('simulator_device: "iPhone 15 Pro"');
    // Round-trips: the parser strips the surrounding quotes.
    expect(loadIosConfig(tmp).appPath).toBe('build/Debug iphonesimulator/MyApp.app');
  });

  it('emits empty placeholders when required fields are blank', () => {
    saveIosConfig(tmp, { appPath: '', bundleId: '' });
    const onDisk = readFileSync(join(tmp, 'qa', 'ios.yml'), 'utf8');
    expect(onDisk).toContain('app_path: ""');
    expect(onDisk).toContain('bundle_id: ""');
    expect(isConfigured(loadIosConfig(tmp))).toBe(false);
  });

  it('creates the qa/ directory if it does not exist', () => {
    expect(existsSync(join(tmp, 'qa'))).toBe(false);
    saveIosConfig(tmp, { appPath: 'build/X.app', bundleId: 'com.x.y' });
    expect(existsSync(join(tmp, 'qa'))).toBe(true);
    expect(existsSync(join(tmp, 'qa', 'ios.yml'))).toBe(true);
  });
});

describe('loadIosConfig auto_build', () => {
  it('defaults autoBuild to true when the key is absent', () => {
    saveIosConfig(tmp, { appPath: 'build/X.app', bundleId: 'com.x.y' });
    expect(loadIosConfig(tmp).autoBuild).toBe(true);
  });

  it('respects auto_build: false', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    writeFileSync(
      join(tmp, 'qa', 'ios.yml'),
      'app_path: build/X.app\nbundle_id: com.x.y\nauto_build: false\n',
      'utf8',
    );
    expect(loadIosConfig(tmp).autoBuild).toBe(false);
  });

  it('accepts truthy aliases (true, 1, yes) and falsy aliases (false, 0, no)', () => {
    for (const v of ['true', '1', 'yes']) {
      mkdirSync(join(tmp, 'qa'), { recursive: true });
      writeFileSync(join(tmp, 'qa', 'ios.yml'), `app_path: a\nbundle_id: b\nauto_build: ${v}\n`);
      expect(loadIosConfig(tmp).autoBuild).toBe(true);
    }
    for (const v of ['false', '0', 'no']) {
      writeFileSync(join(tmp, 'qa', 'ios.yml'), `app_path: a\nbundle_id: b\nauto_build: ${v}\n`);
      expect(loadIosConfig(tmp).autoBuild).toBe(false);
    }
  });
});
