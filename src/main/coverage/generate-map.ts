import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Repo, RunnerKind } from '../../shared/types';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { spawnAgentCli } from '../runners/spawn';
import { runnerEnv } from '../runners/env';
import { effectiveDefaultRunner, resolveRunnerModel } from '../runners/effective-default';
import { buildCodexExecArgs } from '../prompt-compiler/codex-layout';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { parseCoverageMap } from './coverage-map';
import { advanceStage, finishDone, finishFailed, startJob } from './jobs';

const GEN_TIMEOUT_MS = 8 * 60 * 1000;

export interface GenerateMapInput {
  repo: Repo;
  runnerOverride?: RunnerKind;
  modelOverride?: string;
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
    const features = extractFeatures(result.stdout);
    if (!features || features.length === 0) {
      finishFailed(
        jobId,
        'The model did not return a parseable coverage map.',
        'Retry from the toast. If it keeps failing, check that your runner is configured correctly.',
      );
      return;
    }

    advanceStage(jobId, 'writing');

    // Merge with existing map — user-curated labels and globs always win.
    const mapDir = join(input.repo.localPath, 'qa');
    const mapPath = join(mapDir, 'coverage-map.md');
    const existingLabels = new Set<string>();
    const merged: { label: string; globs: string[] }[] = [];
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
    const addedLabels: string[] = [];
    for (const f of features) {
      if (existingLabels.has(f.label)) continue;
      merged.push({ label: f.label, globs: f.globs });
      addedLabels.push(f.label);
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
  const args = ['-p', '--system-prompt', GEN_SYSTEM_PROMPT];
  const model = resolveRunnerModel('claude', modelOverride);
  if (model) args.splice(0, 0, '--model', model);
  return args;
}

function codexArgs(modelOverride?: string): string[] {
  return buildCodexExecArgs({
    sandbox: 'read-only',
    reasoning: 'high',
    modelOverride,
  });
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
    `# Task: produce a comprehensive coverage map for ${repo.githubFullName}`,
    '',
    `Repository root: ${repo.localPath} (current working directory)`,
    '',
    '## Goal',
    'Identify EVERY user-facing feature, domain area, or product surface in this codebase.',
    'For each one, propose:',
    '  • a short kebab-case `label` (e.g. `auth`, `checkout`, `onboarding`, `ios-pilot`)',
    '  • one or more `globs` that point at the files implementing the feature',
    '',
    'Cover the whole app — do not stop at top-level directories. If `src/wealthlab/`',
    'contains many sub-features (`auth`, `charts`, `data`, etc.), emit a label for',
    'each sub-feature, not just one for `wealthlab`. Aim for **8 to 15 labels** total —',
    'enough granularity to drive an actionable coverage radar.',
    '',
    '## Investigation steps (do these BEFORE writing)',
    '1. Read README.md and package.json to understand what the product is.',
    '2. List the top-level entry points (src/index*, src/main/*, app/*, src/renderer/screens/*, src/pages/*, src/routes/*).',
    '3. Walk one level deeper into each candidate dir — note which sub-dirs are real features vs. just utility folders.',
    '4. Map each feature to the smallest glob that covers its files (prefer `src/<feature>/**` over `**/<feature>/**`).',
    '',
    '## Hard requirements',
    '- Labels are unique, lowercase, kebab-case, ≤32 chars.',
    '- Each label has ≥1 glob.',
    '- Globs are valid filesystem patterns (`*` and `**` allowed).',
    '- Do NOT include labels for `node_modules`, `out`, `dist`, `build`, `coverage`, `docs`, `scripts`, `qa`, `evidence`, generic `utils`, `lib`, `components`, etc.',
    '- 8 to 15 labels (more if the repo is genuinely multi-product, fewer for tiny apps).',
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
