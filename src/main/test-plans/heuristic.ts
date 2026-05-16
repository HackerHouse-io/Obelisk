import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { AgentName, TestPlanBlock, TestPlanScope } from '../../shared/types';

/**
 * Deterministic plan skeleton used when no LLM runner is available, or as
 * the seed the LLM generator extends. The output is meant to be rich enough
 * that a user looking at it understands the shape of a real plan, even if
 * each individual case still needs sharpening.
 *
 * Sources of feature names, in priority order:
 *   1. Renderer screen files: src/renderer/screens/*.tsx → "Home", "MissionControl", …
 *   2. Top-level Electron-style domain dirs: src/main/<feature>, src/main/agents/<feature>
 *   3. Web framework conventions: app/*, src/pages/*, src/routes/*, src/features/*
 *   4. README.md headings (## Foo bar) — names humans already use
 *   5. Generic top-level src/ children (filtered against a stop-list)
 *
 * Output: 1 Smoke section + up to ~9 feature sections × 3-5 cases each, capped
 * at 50 cases total so the editor stays readable.
 */
export function buildSkeleton(opts: {
  repoPath: string;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName?: string;
}): TestPlanBlock[] {
  if (opts.scope === 'feature') {
    return buildFeatureSkeleton(opts.featureName ?? 'Feature', opts.agentName);
  }
  return buildWholeAppSkeleton(opts.repoPath, opts.agentName);
}

const MAX_FEATURES = 9;
const MAX_CASES = 50;

function buildWholeAppSkeleton(repoPath: string, agentName: AgentName): TestPlanBlock[] {
  const features = collectFeatures(repoPath);
  const blocks: TestPlanBlock[] = [];

  blocks.push(section('Smoke'));
  for (const c of smokeCases(agentName)) blocks.push(c);

  let caseCount = countCases(blocks);
  for (const feature of features) {
    if (caseCount >= MAX_CASES) break;
    const cases = templateCasesFor(feature, agentName);
    blocks.push(section(prettyName(feature)));
    for (const c of cases) {
      if (caseCount >= MAX_CASES) break;
      blocks.push(c);
      caseCount += 1;
    }
  }

  if (features.length === 0) {
    blocks.push(section('Core flows'));
    for (const c of templateCasesFor('core', agentName)) blocks.push(c);
  }

  return blocks;
}

function buildFeatureSkeleton(featureName: string, agentName: AgentName): TestPlanBlock[] {
  return [
    section(prettyName(featureName)),
    ...templateCasesFor(featureName, agentName),
    section(`${prettyName(featureName)} — edge cases`),
    caseBlock(
      `${prettyName(featureName)}: empty / invalid input`,
      `${prettyName(featureName)} surfaces a clear error and recovers without losing user state.`,
      `Open ${featureName}, submit empty/invalid input, observe error state.`,
      'P1',
    ),
    caseBlock(
      `${prettyName(featureName)}: handles concurrent or rapid actions`,
      'No duplicate writes, no UI flicker, no race conditions on rapid repeats.',
      `Trigger the primary action twice in rapid succession.`,
      'P2',
    ),
  ];
}

function smokeCases(agentName: AgentName): TestPlanBlock[] {
  const ui = agentName !== 'qa-hunter';
  const scope = ['smoke'];
  return [
    caseBlock(
      'App boots without uncaught errors',
      'No uncaught exceptions in console; primary route renders.',
      ui ? 'Open the app, watch console, navigate to home.' : 'Run unit + integration suites.',
      'P0',
      scope,
    ),
    caseBlock(
      'Primary navigation works',
      ui
        ? 'All top-level nav items load their target screens.'
        : 'Routes resolve to expected modules and render targets exist.',
      ui
        ? 'Click each item in the top-level navigation.'
        : 'Inspect router config and render targets.',
      'P1',
      scope,
    ),
    caseBlock(
      'Loading + error states are reachable',
      'Each network-bound view shows a loading state and a recoverable error state.',
      ui
        ? 'Throttle the network or stub fetch to fail; visit the main views.'
        : 'Walk fetch / IO call sites and verify both states are wired.',
      'P1',
      scope,
    ),
  ];
}

function templateCasesFor(feature: string, agentName: AgentName): TestPlanBlock[] {
  const isUi = agentName !== 'qa-hunter';
  const noun = prettyName(feature);
  const scope = [feature.toLowerCase()];
  return [
    caseBlock(
      `${noun}: happy path`,
      `${noun} completes successfully with valid input.`,
      isUi
        ? `Open ${noun}, perform the primary action with valid input, verify success.`
        : `Read the ${feature} module and trace the primary success path end-to-end.`,
      'P0',
      scope,
    ),
    caseBlock(
      `${noun}: surfaces validation errors`,
      'Invalid input shows a clear, in-context error message; user can recover.',
      isUi
        ? `Trigger ${noun} with invalid input.`
        : `Find the validation in code and verify error wiring + UI surface.`,
      'P1',
      scope,
    ),
    caseBlock(
      `${noun}: handles backend / IO failure`,
      'A backend or IO failure shows a recoverable error state, not a crash.',
      isUi
        ? `Trigger ${noun} while offline or with the API stubbed to 5xx.`
        : `Check ${feature} module's failure / retry / fallback paths.`,
      'P1',
      scope,
    ),
    caseBlock(
      `${noun}: state persists across reloads`,
      `${noun}'s output / state survives a page reload (or app restart).`,
      isUi ? `Trigger ${noun}, reload the page, verify state.` : `Inspect persistence layer.`,
      'P2',
      scope,
    ),
  ];
}

/* ---------- Feature discovery ---------- */

export function collectFeatures(repoPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(name: string): void {
    const cleaned = clean(name);
    if (!cleaned) return;
    if (seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  }

  // 1. Renderer screens (Electron / React)
  for (const dir of ['src/renderer/screens', 'src/screens', 'apps/renderer/screens']) {
    for (const f of safeReaddir(join(repoPath, dir))) {
      const m = /^([A-Z][A-Za-z0-9_-]*)\.(tsx|jsx|ts|js)$/.exec(f);
      if (m) add(m[1]!);
    }
  }

  // 2. Electron-style main domain dirs
  for (const dir of ['src/main', 'src/main/agents']) {
    for (const f of safeReaddir(join(repoPath, dir))) {
      if (!isDir(join(repoPath, dir, f))) continue;
      if (looksLikeAFeature(f)) add(f);
    }
  }

  // 3. Web app conventions
  for (const dir of ['app', 'src/pages', 'src/routes', 'src/features', 'src/modules']) {
    for (const f of safeReaddir(join(repoPath, dir))) {
      if (!isDir(join(repoPath, dir, f))) continue;
      if (looksLikeAFeature(f)) add(f);
    }
  }

  // 4. README headings — humans already named features there
  for (const heading of readReadmeHeadings(repoPath)) add(heading);

  // 5. Generic src/* children as a last resort
  for (const f of safeReaddir(join(repoPath, 'src'))) {
    if (!isDir(join(repoPath, 'src', f))) continue;
    if (looksLikeAFeature(f)) add(f);
  }

  return out.slice(0, MAX_FEATURES);
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readReadmeHeadings(repoPath: string): string[] {
  let raw = '';
  try {
    raw = readFileSync(join(repoPath, 'README.md'), 'utf8');
  } catch {
    return [];
  }
  const headings: string[] = [];
  for (const line of raw.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]!.trim();
    if (!text) continue;
    if (
      /^(install|installation|getting started|usage|license|contributing|table of contents)$/i.test(
        text,
      )
    ) {
      continue;
    }
    headings.push(text);
  }
  return headings;
}

const NON_FEATURE_NAMES = new Set([
  '__mocks__',
  '__tests__',
  '_app',
  'assets',
  'common',
  'components',
  'constants',
  'css',
  'db',
  'hooks',
  'helpers',
  'icons',
  'index',
  'layouts',
  'lib',
  'logger',
  'main',
  'middleware',
  'node_modules',
  'pages',
  'preload',
  'public',
  'renderer',
  'routes',
  'screens',
  'scripts',
  'shared',
  'shell',
  'state',
  'static',
  'store',
  'styles',
  'test',
  'tests',
  'types',
  'ui',
  'util',
  'utils',
  'vendor',
]);

function looksLikeAFeature(name: string): boolean {
  if (!name) return false;
  if (NON_FEATURE_NAMES.has(name.toLowerCase())) return false;
  if (name.length > 32) return false;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

function clean(name: string): string {
  return name
    .trim()
    .replace(/^[\s_-]+|[\s_-]+$/g, '')
    .slice(0, 48);
}

function prettyName(raw: string): string {
  const s = raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!s) return raw;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- shared block builders ---------- */

function section(title: string): TestPlanBlock {
  return { kind: 'section', id: ulid(), title };
}

function caseBlock(
  title: string,
  expected: string,
  repro: string,
  severity: 'P0' | 'P1' | 'P2',
  scope: string[] | null = null,
): TestPlanBlock {
  return { kind: 'case', id: ulid(), title, expected, repro, severity, scope };
}

function countCases(blocks: TestPlanBlock[]): number {
  return blocks.reduce((n, b) => (b.kind === 'case' ? n + 1 : n), 0);
}

/** Try to read a hint about features from the repo. Best effort, never throws. */
export function readPackageNameHint(repoPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string') return pkg.name;
  } catch {
    // ignore
  }
  return null;
}
