import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ulid } from 'ulid';
import type { Repo, RunnerKind } from '../../shared/types';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { spawnAgentCli } from '../runners/spawn';
import { runnerEnv } from '../runners/env';
import { effectiveDefaultRunner } from '../runners/effective-default';
import { buildOneShotClaudeArgs, buildOneShotCodexArgs } from '../agents/lib/oneshot-cli-args';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { matchesAnyGlob, parseCoverageMap } from './coverage-map';
import { advanceStage, finishDone, finishFailed, startJob } from './jobs';

/** Hard cap on labels written to disk. The prompt asks for 5–8 so this is the ceiling. */
const MAX_LABELS = 8;
/** Minimum tracked files a glob must match before we accept the label. */
const MIN_FILES_PER_LABEL = 1;

const GEN_TIMEOUT_MS = 8 * 60 * 1000;

export interface GenerateMapInput {
  repo: Repo;
  runnerOverride?: RunnerKind;
  modelOverride?: string;
  /**
   * When true (default), the new LLM-proposed features REPLACE the existing
   * `qa/coverage-map.md`. When false, the new features are MERGED on top of
   * the existing labels (legacy behavior — opt-in via the "Keep existing
   * labels" checkbox in the regenerate dialog).
   *
   * Replace is the default because the previous merge-only behavior turned
   * repeated regenerates into a silent accumulator, ballooning real users'
   * maps to 60+ labels and breaking the radar.
   */
  replace?: boolean;
}

/**
 * Kick off LLM-driven coverage-map generation. Spawns Claude / Codex CLI
 * to read the entire codebase and propose a comprehensive feature list —
 * same pattern test plan generation uses. Returns a jobId immediately;
 * progress is broadcast via `coverageMapGeneration.progress`.
 *
 * The output is MERGED with the existing `qa/coverage-map.md` — existing
 * labels (and any custom globs the user wrote) win on collision so user
 * edits survive the regeneration.
 */
export function startMapGenerationJob(input: GenerateMapInput): string {
  const job = startJob({ repoId: input.repo.id });
  void runJob(job.jobId, input).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    finishFailed(job.jobId, message);
  });
  return job.jobId;
}

async function runJob(jobId: string, input: GenerateMapInput): Promise<void> {
  advanceStage(jobId, 'spawning');

  const runnerKind = await pickInstalledRunner(input.repo, input.runnerOverride);
  if (!runnerKind) {
    finishFailed(
      jobId,
      input.runnerOverride
        ? `${input.runnerOverride} CLI is not installed.`
        : 'Neither Claude Code nor Codex CLI is installed.',
      "Install one and make sure it's on your PATH. Try `claude --version` or `codex --version` in a terminal.",
    );
    return;
  }

  const runId = `cmg-${ulid().slice(-8).toLowerCase()}`;
  const wt = await createWorktree({
    repoPath: input.repo.localPath,
    repoId: input.repo.id,
    runId,
    baseBranch: input.repo.defaultBranch,
  });

  try {
    advanceStage(jobId, 'reading');

    const args =
      runnerKind === 'codex' ? codexArgs(input.modelOverride) : claudeArgs(input.modelOverride);
    const stdin = generatorPrompt(input.repo);
    const abort = new AbortController();
    let lastTickAt = 0;
    const result = await spawnAgentCli({
      command: runnerKind,
      args,
      cwd: wt.worktreePath,
      env: runnerEnv(),
      stdin,
      timeoutMs: GEN_TIMEOUT_MS,
      onAudit: (line) => {
        if (line.kind !== 'stdout' || typeof line.payload !== 'string') return;
        const text = line.payload.slice(0, 80).trim();
        if (!text) return;
        const now = Date.now();
        if (now - lastTickAt < 500) return;
        lastTickAt = now;
        advanceStage(jobId, 'reading', `Analyzing: ${text}…`);
      },
      abort: abort.signal,
    });

    if (result.timedOut) {
      finishFailed(
        jobId,
        `Generation timed out after ${Math.round(GEN_TIMEOUT_MS / 60_000)} minutes.`,
        'The codebase may be large. Try again, or edit qa/coverage-map.md by hand.',
      );
      return;
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdoutTail = result.stdout.trim().split('\n').slice(-3).join(' | ').slice(-400);
      const hint =
        stderr.length > 0
          ? stderr.slice(-400)
          : stdoutTail || `Run \`${runnerKind} --version\` to verify your installation.`;
      finishFailed(jobId, `${runnerKind} exited ${result.exitCode ?? '?'}.`, hint);
      return;
    }

    advanceStage(jobId, 'reading', 'Parsing model output…');
    const rawFeatures = extractFeatures(result.stdout);
    if (!rawFeatures || rawFeatures.length === 0) {
      finishFailed(
        jobId,
        'The model did not return a parseable coverage map.',
        'Retry from the toast. If it keeps failing, check that your runner is configured correctly.',
      );
      return;
    }

    // Validate the LLM's globs against the actual tracked-files list.
    // Anything matching < MIN_FILES_PER_LABEL is a speculative label we
    // refuse to write — surfacing it as a feature card with "Run QA Hunter"
    // would be misleading. Cap the survivors at MAX_LABELS so the radar
    // stays legible (the prompt asks for ≤10 but we enforce a hard ceiling).
    const trackedFiles = await listTrackedFiles(input.repo.localPath);
    const validated: { label: string; globs: string[]; filesMatched: number }[] = [];
    const droppedZeroFile: string[] = [];
    for (const f of rawFeatures) {
      const matched = trackedFiles.filter((p) => matchesAnyGlob(p, f.globs)).length;
      if (matched < MIN_FILES_PER_LABEL) {
        droppedZeroFile.push(f.label);
        continue;
      }
      validated.push({ label: f.label, globs: f.globs, filesMatched: matched });
    }
    // Keep the labels covering the MOST surface area — likely real features.
    validated.sort((a, b) => b.filesMatched - a.filesMatched);
    const features = validated.slice(0, MAX_LABELS);

    if (features.length === 0) {
      finishFailed(
        jobId,
        "None of the model's proposed labels matched any tracked files.",
        droppedZeroFile.length > 0
          ? `Dropped: ${droppedZeroFile.slice(0, 6).join(', ')}. The model may have hallucinated paths — retry or edit qa/coverage-map.md by hand.`
          : 'Retry, or edit qa/coverage-map.md by hand.',
      );
      return;
    }

    advanceStage(jobId, 'writing');

    const mapDir = join(input.repo.localPath, 'qa');
    const mapPath = join(mapDir, 'coverage-map.md');
    const replaceMode = input.replace !== false; // default true

    let merged: { label: string; globs: string[] }[];
    let addedLabels: string[];

    if (replaceMode) {
      // Replace mode: the LLM's proposals ARE the entire new map. Existing
      // labels are wiped. This is the default because the prior merge-only
      // behavior accumulated stale labels every regen.
      merged = features.map((f) => ({ label: f.label, globs: f.globs }));
      addedLabels = features.map((f) => f.label);
    } else {
      // Merge mode (opt-in via "Keep existing labels"): preserve existing
      // entries and append any new LLM labels not already present.
      const existingLabels = new Set<string>();
      merged = [];
      if (existsSync(mapPath)) {
        try {
          const existing = parseCoverageMap(readFileSync(mapPath, 'utf8'));
          for (const [label, globs] of existing) {
            merged.push({ label, globs });
            existingLabels.add(label);
          }
        } catch {
          // unparseable → treat as absent.
        }
      }
      addedLabels = [];
      for (const f of features) {
        if (existingLabels.has(f.label)) continue;
        merged.push({ label: f.label, globs: f.globs });
        addedLabels.push(f.label);
      }
    }

    try {
      mkdirSync(mapDir, { recursive: true });
    } catch {
      // mkdir may race; let writeFile surface a clean error below.
    }
    writeFileSync(mapPath, renderCoverageMap(merged), 'utf8');

    finishDone(jobId, { labelCount: merged.length, addedLabels });

    // Notify the renderer's coverage screen to refresh.
    const { broadcast } = await import('../ipc/bus');
    broadcast({ type: 'testPlans.changed', repoId: input.repo.id });
  } finally {
    await destroyWorktree(input.repo.localPath, wt.worktreePath).catch(() => undefined);
  }
}

async function pickInstalledRunner(repo: Repo, override?: RunnerKind): Promise<RunnerKind | null> {
  if (override) {
    const runner = override === 'codex' ? new CodexRunner() : new ClaudeCodeRunner();
    const status = await runner.isInstalled();
    return status.ok ? override : null;
  }
  const preferred = effectiveDefaultRunner(repo);
  const order: RunnerKind[] = preferred === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const kind of order) {
    const runner = kind === 'codex' ? new CodexRunner() : new ClaudeCodeRunner();
    const status = await runner.isInstalled();
    if (status.ok) return kind;
  }
  return null;
}

function claudeArgs(modelOverride?: string): string[] {
  return buildOneShotClaudeArgs({ systemPrompt: GEN_SYSTEM_PROMPT, modelOverride });
}

function codexArgs(modelOverride?: string): string[] {
  return buildOneShotCodexArgs({ reasoning: 'high', modelOverride });
}

const GEN_SYSTEM_PROMPT = [
  'You are a senior software architect mapping a codebase into testable features.',
  'You read the repository at the current working directory and produce a JSON list',
  'of feature labels and the file globs that target each one.',
  '',
  'You return STRICTLY the JSON object specified in the user message between',
  'BEGIN_COVERAGE_MAP and END_COVERAGE_MAP markers — no commentary, no surrounding',
  'narrative. Do not add fields, do not omit fields.',
].join(' ');

function generatorPrompt(repo: Repo): string {
  return [
    `# Task: produce a high-level coverage map for ${repo.githubFullName}`,
    '',
    `Repository root: ${repo.localPath} (current working directory)`,
    '',
    '## Goal',
    "Identify the **5–10 top-level features** that matter most to this product's users.",
    "Think 'major product surface', not 'every nested directory'. A user looking at the",
    'Coverage screen needs a punchy summary of where their app is well-tested vs. dark —',
    '50 micro-features make the radar unreadable and the cards useless.',
    '',
    'For each feature, propose:',
    '  • a short kebab-case `label` (e.g. `auth`, `checkout`, `onboarding`, `ios-pilot`)',
    '  • one or more `globs` that point at the files implementing the feature',
    '',
    '## Investigation steps (do these BEFORE writing)',
    '1. Read README.md and package.json to understand what the product DOES.',
    '2. List the top-level entry points (src/index*, src/main/*, app/*, src/renderer/screens/*, src/pages/*, src/routes/*).',
    '3. Group related code into product surfaces a user would recognise (auth, checkout, dashboard, settings, …). Do NOT enumerate every sub-folder — group them.',
    '4. Map each feature to the smallest glob that covers its files (prefer `src/<feature>/**` over `**/<feature>/**`). Glob MUST match real tracked paths in the repo.',
    '',
    '## Hard requirements',
    '- 5 to 8 labels (NEVER more than 8). Tiny apps can use 3–5. The radar becomes unreadable beyond 8.',
    '- Labels are unique, lowercase, kebab-case, ≤32 chars.',
    '- Each label has ≥1 glob and the glob MUST match real files in this repo.',
    '- Globs are valid filesystem patterns (`*` and `**` allowed).',
    '- Do NOT include labels for `node_modules`, `out`, `dist`, `build`, `coverage`, `docs`, `scripts`, `qa`, `evidence`, generic `utils`, `lib`, `components`, etc.',
    '- Prefer ONE label per product surface. Sub-features can be added later by hand.',
    '',
    '## Output format (STRICT)',
    'Emit ONLY the following block, nothing else:',
    '',
    'BEGIN_COVERAGE_MAP',
    '{',
    '  "features": [',
    '    { "label": "auth", "globs": ["src/auth/**", "src/middleware/auth*.ts"] },',
    '    { "label": "checkout", "globs": ["src/checkout/**"] },',
    '    { "label": "onboarding", "globs": ["src/onboarding/**"] }',
    '  ]',
    '}',
    'END_COVERAGE_MAP',
  ].join('\n');
}

export interface GeneratedFeature {
  label: string;
  globs: string[];
}

/**
 * Extract the feature JSON from the LLM's stdout. Tries multiple shapes:
 *   1. BEGIN_COVERAGE_MAP ... END_COVERAGE_MAP markers (system prompt).
 *   2. ```json ... ``` fenced block.
 *   3. Largest balanced { ... } object containing `"features"`.
 */
export function extractFeatures(stdout: string): GeneratedFeature[] | null {
  const candidates: string[] = [];

  const marker = /BEGIN_COVERAGE_MAP\s*([\s\S]*?)\s*END_COVERAGE_MAP/.exec(stdout);
  if (marker) candidates.push(marker[1]!);

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(stdout);
  if (fence) candidates.push(fence[1]!);

  const balanced = findLargestJsonObject(stdout);
  if (balanced) candidates.push(balanced);

  for (const raw of candidates) {
    const features = tryParseFeatures(raw);
    if (features && features.length > 0) return features;
  }
  return null;
}

function tryParseFeatures(raw: string): GeneratedFeature[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (parsed as { features?: unknown }).features;
  if (!Array.isArray(arr)) return null;

  const out: GeneratedFeature[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const label = typeof o.label === 'string' ? normalizeLabel(o.label) : '';
    if (!label) continue;
    if (seen.has(label)) continue;
    const globs = Array.isArray(o.globs)
      ? o.globs
          .filter((g): g is string => typeof g === 'string')
          .map((g) => g.trim())
          .filter(Boolean)
      : [];
    if (globs.length === 0) continue;
    seen.add(label);
    out.push({ label, globs: Array.from(new Set(globs)) });
  }
  return out;
}

function findLargestJsonObject(text: string): string | null {
  let best: string | null = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        if (candidate.includes('"features"') && (!best || candidate.length > best.length)) {
          best = candidate;
        }
        start = -1;
      }
    }
  }
  return best;
}

function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function renderCoverageMap(entries: { label: string; globs: string[] }[]): string {
  const lines: string[] = [];
  lines.push('# Coverage map');
  lines.push('');
  lines.push('<!-- Generated by Claude Code / Codex via the Coverage screen.');
  lines.push('     Each entry maps a label to one or more file globs. Tag your');
  lines.push('     test cases with a label (e.g. `scope: [auth]`) and they will');
  lines.push('     count toward that feature on the Coverage radar.');
  lines.push('');
  lines.push('     Edit this file directly to refine globs or remove stale labels. -->');
  lines.push('');
  for (const e of entries) {
    lines.push(`- \`${e.label}\`: ${e.globs.map((g) => `\`${g}\``).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function listTrackedFiles(repoPath: string): Promise<string[]> {
  try {
    const out = await simpleGit(repoPath).raw(['ls-files']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(
        (p) => !p.startsWith('node_modules/') && !p.startsWith('out/') && !p.startsWith('dist/'),
      );
  } catch {
    return [];
  }
}
