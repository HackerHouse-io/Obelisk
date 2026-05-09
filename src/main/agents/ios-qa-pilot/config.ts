import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * If true (default) the orchestrator runs `xcodebuild build` before
   * each iOS QA Pilot run so the simulator installs the latest source.
   * Set to false if your `app_path` points at a pre-built artifact you
   * manage outside Obelisk.
   */
  autoBuild: boolean;
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
  autoBuild: true,
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
      case 'auto_build': {
        const v = value.trim().toLowerCase();
        if (v === 'false' || v === '0' || v === 'no') out.autoBuild = false;
        else if (v === 'true' || v === '1' || v === 'yes') out.autoBuild = true;
        break;
      }
    }
  }
  return out;
}

export function isConfigured(cfg: IosConfig): boolean {
  return cfg.appPath.length > 0 && cfg.bundleId.length > 0;
}

export interface IosConfigPatch {
  appPath?: string;
  bundleId?: string;
  simulatorDevice?: string;
  simulatorOs?: string;
  flowsDir?: string;
  maxParallel?: number;
  appiumPortBase?: number;
  wdaPortBase?: number;
}

const KEY_TO_YAML: Record<keyof IosConfigPatch, string> = {
  appPath: 'app_path',
  bundleId: 'bundle_id',
  simulatorDevice: 'simulator_device',
  simulatorOs: 'simulator_os',
  flowsDir: 'flows_dir',
  maxParallel: 'max_parallel',
  appiumPortBase: 'appium_port_base',
  wdaPortBase: 'wda_port_base',
};

const ORDER: (keyof IosConfigPatch)[] = [
  'appPath',
  'bundleId',
  'simulatorDevice',
  'simulatorOs',
  'flowsDir',
  'maxParallel',
  'appiumPortBase',
  'wdaPortBase',
];

/**
 * Merge a partial config into `qa/ios.yml`. Preserves untouched keys we
 * already know about, but rewrites the file (comments are not preserved).
 * Empty strings in the patch *do* set the field — pass undefined to leave
 * a field alone.
 *
 * Returns the merged config so callers can re-render UI without a second
 * read.
 */
export function saveIosConfig(repoPath: string, patch: IosConfigPatch): IosConfig {
  const current = loadIosConfig(repoPath);
  const merged: IosConfig = {
    appPath: patch.appPath !== undefined ? patch.appPath.trim() : current.appPath,
    bundleId: patch.bundleId !== undefined ? patch.bundleId.trim() : current.bundleId,
    simulatorDevice:
      patch.simulatorDevice !== undefined ? patch.simulatorDevice : current.simulatorDevice,
    simulatorOs: patch.simulatorOs !== undefined ? patch.simulatorOs : current.simulatorOs,
    flowsDir: patch.flowsDir !== undefined ? patch.flowsDir : current.flowsDir,
    maxParallel: patch.maxParallel !== undefined ? patch.maxParallel : current.maxParallel,
    appiumPortBase:
      patch.appiumPortBase !== undefined ? patch.appiumPortBase : current.appiumPortBase,
    wdaPortBase: patch.wdaPortBase !== undefined ? patch.wdaPortBase : current.wdaPortBase,
    // autoBuild is not exposed via the patch surface today (only the
    // qa/ios.yml hand-edit lets users opt out). Preserve it on save.
    autoBuild: current.autoBuild,
  };

  const lines: string[] = [
    '# iOS QA Pilot configuration. Managed by Obelisk; manual edits to',
    '# unrecognized keys are preserved on next save only if you keep the',
    '# `key: value` syntax.',
    '',
  ];
  for (const key of ORDER) {
    const value = merged[key];
    if (value === '' || value === undefined) continue;
    const yamlKey = KEY_TO_YAML[key];
    lines.push(`${yamlKey}: ${formatYamlValue(value)}`);
  }
  // Always emit the required keys even when empty, so the file shape stays
  // self-explanatory ("here's where app_path lives, fill it in").
  if (!merged.appPath) lines.push('app_path: ""');
  if (!merged.bundleId) lines.push('bundle_id: ""');
  lines.push('');

  mkdirSync(join(repoPath, 'qa'), { recursive: true });
  writeFileSync(join(repoPath, 'qa', 'ios.yml'), lines.join('\n'), 'utf8');
  return merged;
}

function formatYamlValue(v: string | number): string {
  if (typeof v === 'number') return String(v);
  // Quote strings that contain whitespace or YAML-special chars; leave
  // simple identifiers/paths bare so the file stays human-readable.
  if (/^[-A-Za-z0-9_./@:+]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}
