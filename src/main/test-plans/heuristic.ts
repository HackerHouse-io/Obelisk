import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { AgentName, TestPlanBlock, TestPlanScope } from '../../shared/types';

/**
 * Deterministic plan skeleton used when no LLM runner is available, or as
 * the seed the LLM generator extends. The output is not a real test plan —
 * it's a useful starting point the user is expected to edit.
 *
 * Strategy:
 *   - whole-app: one section per top-level feature directory (src/<feature>/
 *     or app/<feature>/), plus a "Smoke" section.
 *   - feature: one section for the named feature, with template cases.
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

function buildWholeAppSkeleton(repoPath: string, agentName: AgentName): TestPlanBlock[] {
  const features = detectFeatures(repoPath);
  const blocks: TestPlanBlock[] = [];

  blocks.push(section('Smoke'));
  for (const c of smokeCases(agentName)) blocks.push(c);

  for (const feature of features) {
    blocks.push(section(capitalize(feature)));
    for (const c of templateCasesFor(feature, agentName)) blocks.push(c);
  }

  if (features.length === 0) {
    blocks.push(section('Core flows'));
    for (const c of templateCasesFor('core', agentName)) blocks.push(c);
  }

  return blocks;
}

function buildFeatureSkeleton(featureName: string, agentName: AgentName): TestPlanBlock[] {
  return [
    section(capitalize(featureName)),
    ...templateCasesFor(featureName, agentName),
    section(`${capitalize(featureName)} — edge cases`),
    caseBlock(
      `Empty / invalid input on ${featureName}`,
      `${capitalize(featureName)} surfaces a clear error and recovers.`,
      `Open ${featureName}, submit empty/invalid input, observe error state.`,
      'P1',
    ),
  ];
}

function smokeCases(agentName: AgentName): TestPlanBlock[] {
  const ui = agentName !== 'qa-hunter';
  return [
    caseBlock(
      'App boots without uncaught errors',
      'No uncaught exceptions in console; primary route renders.',
      ui ? 'Open the app, watch console, navigate to home.' : 'Run unit + integration suites.',
      'P0',
    ),
    caseBlock(
      'Primary navigation works',
      ui
        ? 'All top-level nav items load their target screens.'
        : 'Routes resolve to expected modules.',
      ui
        ? 'Click each item in the top-level navigation.'
        : 'Inspect router config and render targets.',
      'P1',
    ),
  ];
}

function templateCasesFor(feature: string, agentName: AgentName): TestPlanBlock[] {
  const isUi = agentName !== 'qa-hunter';
  const noun = capitalize(feature);
  return [
    caseBlock(
      `${noun}: happy path`,
      `${noun} completes successfully with valid input.`,
      isUi
        ? `Open ${feature}, perform the primary action with valid input.`
        : `Read the ${feature} module and trace the primary success path.`,
      'P0',
    ),
    caseBlock(
      `${noun}: surfaces validation errors`,
      'Invalid input shows a clear, in-context error message.',
      isUi
        ? `Trigger ${feature} with invalid input.`
        : `Find the validation in code and check error wiring.`,
      'P1',
    ),
    caseBlock(
      `${noun}: handles network / IO failure`,
      'A backend or IO failure shows a recoverable error state.',
      isUi
        ? `Trigger ${feature} while offline or with the API stubbed to 5xx.`
        : `Check ${feature} module's failure / retry / fallback paths.`,
      'P1',
    ),
  ];
}

function detectFeatures(repoPath: string): string[] {
  const candidates = ['src', 'app', 'lib', 'apps'];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const full = join(repoPath, dir);
    if (!existsSync(full)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith('.') || e.startsWith('_')) continue;
      const sub = join(full, e);
      let stat;
      try {
        stat = statSync(sub);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (looksLikeAFeature(e)) seen.add(e);
    }
  }
  // Stable order, capped so the file stays editable in one screenful.
  const result = [...seen].sort();
  return result.slice(0, 8);
}

const NON_FEATURE_NAMES = new Set([
  'node_modules',
  'shared',
  'common',
  'utils',
  'helpers',
  'types',
  'styles',
  'assets',
  'public',
  'static',
  'main',
  'preload',
  'renderer',
  'index',
  'components',
  'hooks',
  'state',
  'ui',
  'icons',
  'screens',
  'pages',
  'routes',
  'tests',
  'test',
  '__tests__',
]);

function looksLikeAFeature(name: string): boolean {
  if (NON_FEATURE_NAMES.has(name.toLowerCase())) return false;
  if (name.length > 32) return false;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

function section(title: string): TestPlanBlock {
  return { kind: 'section', id: ulid(), title };
}

function caseBlock(
  title: string,
  expected: string,
  repro: string,
  severity: 'P0' | 'P1' | 'P2',
): TestPlanBlock {
  return { kind: 'case', id: ulid(), title, expected, repro, severity };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
