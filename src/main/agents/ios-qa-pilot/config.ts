import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IosConfig {
  /** Path to the Debug-iphonesimulator .app bundle, relative to the repo root. */
  appPath: string;
  /** App bundle identifier (used by Appium when launching). */
  bundleId: string;
  /** Simulator device family, e.g. "iPhone 15". */
  simulatorDevice: string;
  /** Runtime, e.g. "17.4". */
  simulatorOs: string;
  /** Where flow files live (relative to repo root). */
  flowsDir: string;
  /** Max parallel runs (= simulator pool size). */
  maxParallel: number;
  /** Base ports — slot i uses (appiumPortBase+i, wdaPortBase+i). */
  appiumPortBase: number;
  wdaPortBase: number;
}

const DEFAULTS: IosConfig = {
  appPath: '',
  bundleId: '',
  simulatorDevice: 'iPhone 15',
  simulatorOs: '',
  flowsDir: 'qa/ios-flows',
  maxParallel: 2,
  appiumPortBase: 4723,
  wdaPortBase: 8100,
};

/**
 * Tiny YAML-like reader: supports `key: value` lines and nothing else.
 * The `qa/ios.yml` file is small and hand-edited; pulling in a YAML
 * dependency would be heavier than the parsing it saves.
 */
export function loadIosConfig(repoPath: string): IosConfig {
  const p = join(repoPath, 'qa', 'ios.yml');
  if (!existsSync(p)) return { ...DEFAULTS };
  const text = readFileSync(p, 'utf8');
  const out: IosConfig = { ...DEFAULTS };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.replace(/^["']|["']$/g, '');
    switch (key) {
      case 'app_path':
        out.appPath = value;
        break;
      case 'bundle_id':
        out.bundleId = value;
        break;
      case 'simulator_device':
        out.simulatorDevice = value;
        break;
      case 'simulator_os':
        out.simulatorOs = value;
        break;
      case 'flows_dir':
        out.flowsDir = value;
        break;
      case 'max_parallel': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0 && n <= 8) out.maxParallel = n;
        break;
      }
      case 'appium_port_base': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.appiumPortBase = n;
        break;
      }
      case 'wda_port_base': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.wdaPortBase = n;
        break;
      }
    }
  }
  return out;
}

export function isConfigured(cfg: IosConfig): boolean {
  return cfg.appPath.length > 0 && cfg.bundleId.length > 0;
}
