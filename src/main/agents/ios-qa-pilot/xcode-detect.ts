import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type ExecFn = typeof exec;

export interface XcodeProjectRef {
  type: 'workspace' | 'project';
  /** Absolute path to the .xcworkspace or .xcodeproj directory. */
  path: string;
  /** Project/workspace name without the extension. */
  name: string;
}

export interface DetectedIosConfig {
  /** `.app` bundle path relative to the repo root. */
  appPath: string;
  bundleId: string;
  scheme: string;
  project: XcodeProjectRef;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'Pods',
  'build',
  'DerivedData',
  '.build',
  'dist',
  'out',
]);
const MAX_DEPTH = 4;

/**
 * Walk the repo (depth-limited) looking for an iOS project. A workspace
 * always wins over a bare project at the same level — that matches the
 * CocoaPods/SPM convention where `App.xcworkspace` aggregates `App.xcodeproj`
 * with the Pods project. Hidden dirs and obvious build outputs are skipped.
 */
export function findXcodeProject(repoPath: string): XcodeProjectRef | null {
  let firstProject: XcodeProjectRef | null = null;

  function isDir(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  function scan(dir: string, depth: number): XcodeProjectRef | null {
    if (depth > MAX_DEPTH) return null;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const dirs = names.filter((n) => isDir(join(dir, n)));
    const ws = dirs.find((n) => n.endsWith('.xcworkspace'));
    if (ws) {
      return {
        type: 'workspace',
        path: join(dir, ws),
        name: ws.replace(/\.xcworkspace$/, ''),
      };
    }
    const proj = dirs.find((n) => n.endsWith('.xcodeproj'));
    if (proj && !firstProject) {
      firstProject = {
        type: 'project',
        path: join(dir, proj),
        name: proj.replace(/\.xcodeproj$/, ''),
      };
    }
    for (const n of dirs) {
      if (SKIP_DIRS.has(n)) continue;
      if (n.startsWith('.')) continue;
      if (n.endsWith('.xcworkspace') || n.endsWith('.xcodeproj')) continue;
      const found = scan(join(dir, n), depth + 1);
      if (found && found.type === 'workspace') return found;
    }
    return null;
  }

  return scan(repoPath, 0) ?? firstProject;
}

interface ListJson {
  workspace?: { name: string; schemes: string[] };
  project?: { name: string; schemes: string[] };
}

export async function listSchemes(project: XcodeProjectRef, run: ExecFn = exec): Promise<string[]> {
  const args =
    project.type === 'workspace'
      ? ['-workspace', project.path, '-list', '-json']
      : ['-project', project.path, '-list', '-json'];
  const { stdout } = await run('xcodebuild', args, { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout) as ListJson;
  return data.workspace?.schemes ?? data.project?.schemes ?? [];
}

interface BuildSettingsEntry {
  buildSettings: Record<string, string>;
}

export interface RawBuildSettings {
  bundleId: string;
  productsDir: string;
  wrapperName: string;
}

export async function extractBuildSettings(
  project: XcodeProjectRef,
  scheme: string,
  derivedDataPath: string,
  run: ExecFn = exec,
): Promise<RawBuildSettings | null> {
  const args = [
    project.type === 'workspace' ? '-workspace' : '-project',
    project.path,
    '-scheme',
    scheme,
    '-configuration',
    'Debug',
    '-sdk',
    'iphonesimulator',
    '-derivedDataPath',
    derivedDataPath,
    '-showBuildSettings',
    '-json',
  ];
  let stdout: string;
  try {
    const r = await run('xcodebuild', args, { maxBuffer: 32 * 1024 * 1024 });
    stdout = r.stdout;
  } catch {
    return null;
  }
  let entries: BuildSettingsEntry[];
  try {
    entries = JSON.parse(stdout) as BuildSettingsEntry[];
  } catch {
    return null;
  }
  for (const entry of entries) {
    const s = entry.buildSettings;
    if (s.PRODUCT_BUNDLE_IDENTIFIER && s.BUILT_PRODUCTS_DIR && s.WRAPPER_NAME) {
      return {
        bundleId: s.PRODUCT_BUNDLE_IDENTIFIER,
        productsDir: s.BUILT_PRODUCTS_DIR,
        wrapperName: s.WRAPPER_NAME,
      };
    }
  }
  return null;
}

/**
 * Locate the iOS project, pick a scheme, ask xcodebuild for the bundle id
 * and product path. Returns null on any failure (no project, no schemes,
 * xcodebuild unavailable, parse error) so callers can fall back to manual
 * configuration without throwing.
 */
export async function detectIosConfig(
  repoPath: string,
  run: ExecFn = exec,
): Promise<DetectedIosConfig | null> {
  const project = findXcodeProject(repoPath);
  if (!project) return null;

  let schemes: string[];
  try {
    schemes = await listSchemes(project, run);
  } catch {
    return null;
  }
  if (schemes.length === 0) return null;

  // Heuristic: prefer a scheme whose name matches the project; otherwise
  // take the first non-test-looking scheme; otherwise the first one.
  const scheme =
    schemes.find((s) => s === project.name) ??
    schemes.find((s) => !/test|tests|uitests/i.test(s)) ??
    schemes[0]!;

  // Pin derivedDataPath inside the repo so the resulting app_path is
  // stable and relative-friendly (no absolute DerivedData paths).
  const derivedDataPath = join(repoPath, 'build');
  const settings = await extractBuildSettings(project, scheme, derivedDataPath, run);
  if (!settings) return null;

  const absApp = join(settings.productsDir, settings.wrapperName);
  let appPath = relative(repoPath, absApp);
  // Path.relative on different volumes returns something absolute; in that
  // edge case keep the absolute form rather than emit a broken relative.
  if (appPath.startsWith('..') && !absApp.startsWith(repoPath + sep)) {
    appPath = absApp;
  }

  return {
    appPath,
    bundleId: settings.bundleId,
    scheme,
    project,
  };
}

export interface BuildAppOpts {
  project: XcodeProjectRef;
  scheme: string;
  derivedDataPath: string;
  configuration?: string;
  sdk?: string;
  /** Bytes of stderr to keep on failure (truncates the start). */
  errorTailBytes?: number;
}

export interface BuildAppResult {
  /** Whole `xcodebuild build` invocation, for the audit trail. */
  command: string;
  durationMs: number;
}

/**
 * Run `xcodebuild build` so the next iOS QA Pilot run installs the
 * latest source — without this every run installs whatever .app
 * happened to be on disk, which goes stale within minutes of editing.
 *
 * Throws on non-zero exit with a truncated stderr/stdout tail attached
 * via the Error.message so the orchestrator can surface a useful audit
 * line.
 *
 * Incremental: xcodebuild's own dependency graph means an unchanged
 * source tree completes in ~5 seconds. Full rebuilds happen only when
 * source actually changed.
 */
export async function buildApp(opts: BuildAppOpts, run: ExecFn = exec): Promise<BuildAppResult> {
  const args = [
    opts.project.type === 'workspace' ? '-workspace' : '-project',
    opts.project.path,
    '-scheme',
    opts.scheme,
    '-configuration',
    opts.configuration ?? 'Debug',
    '-sdk',
    opts.sdk ?? 'iphonesimulator',
    '-derivedDataPath',
    opts.derivedDataPath,
    'build',
  ];
  const command = `xcodebuild ${args.join(' ')}`;
  const start = Date.now();
  try {
    await run('xcodebuild', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const tailBytes = opts.errorTailBytes ?? 4000;
    const withStreams = e as { stderr?: string; stdout?: string; message?: string };
    const stderr = (withStreams.stderr ?? '').toString();
    const stdout = (withStreams.stdout ?? '').toString();
    const tail = (stderr || stdout).slice(-tailBytes).trim();
    const baseMessage = withStreams.message ?? 'xcodebuild build failed';
    throw new Error(tail ? `${baseMessage}\n\nLast output:\n${tail}` : baseMessage);
  }
  return { command, durationMs: Date.now() - start };
}
