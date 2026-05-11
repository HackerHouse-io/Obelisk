import { ulid } from 'ulid';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo, TestPlanBlock, TestPlanScope } from '../../shared/types';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { spawnAgentCli } from '../runners/spawn';
import { runnerEnv } from '../runners/env';
import { effectiveDefaultRunner, resolveRunnerModel } from '../runners/effective-default';
import { buildCodexExecArgs } from '../prompt-compiler/codex-layout';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { buildSkeleton } from './heuristic';
import { createPlan } from './store';
import { advanceStage, finishDone, finishFailed, startJob } from './jobs';
import type { TestPlan } from '../../shared/types';
import { buildCoverageReport, pickFocusFiles, type FocusFile } from '../coverage/aggregate';

/**
 * Plan generation flow:
 *   1. Start a job (returns immediately with `jobId`).
 *   2. Async worker spawns claude/codex against an isolated worktree, asks
 *      for a structured per-feature plan with strict JSON output, parses it.
 *   3. On success, write the plan markdown to qa/test-plans/<id>.md and
 *      finishDone(jobId, planId).
 *   4. On any failure (no runner, timeout, parse error), finishFailed(jobId).
 *
 * The heuristic walker is used only as a *seed* embedded into the LLM prompt
 * to give the model a starting frame; we never write the heuristic output
 * directly as a plan. The user explicitly clicked "Draft plan" — they want
 * a real LLM-driven plan, not a template.
 */
const GEN_TIMEOUT_MS = 8 * 60 * 1000;

export interface GenerateInput {
  repo: Repo;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName?: string;
  /** Override the global Settings runner for this generation. */
  runnerOverride?: 'claude' | 'codex';
  /**
   * Override the global Settings model for this generation. Empty string means
   * "force-use the CLI's default" (skip the `--model` flag); undefined means
   * "fall through to Settings".
   */
  modelOverride?: string;
  /**
   * When true, the generator queries the coverage report and biases the
   * prompt toward files that are uncovered, recently churned, or carrying
   * open findings. No effect on the heuristic seed (which is just a
   * scaffold the AI replaces anyway).
   */
  focusOnChangedOrUncovered?: boolean;
}

/**
 * Kick off generation. Returns the jobId immediately; the actual work runs
 * in the background and reports progress via the bus.
 */
export function startGenerationJob(input: GenerateInput): string {
  const job = startJob({
    repoId: input.repo.id,
    agentName: input.agentName,
    scope: input.scope,
    ...(input.featureName ? { featureName: input.featureName } : {}),
  });
  void runJob(job.jobId, input).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    finishFailed(job.jobId, message);
  });
  return job.jobId;
}

async function runJob(jobId: string, input: GenerateInput): Promise<void> {
  advanceStage(jobId, 'spawning');

  const runnerKind = await pickInstalledRunner(input.repo, input.runnerOverride);
  if (!runnerKind) {
    finishFailed(
      jobId,
      input.runnerOverride
        ? `${input.runnerOverride} CLI is not installed.`
        : 'Neither Claude Code nor Codex CLI is installed.',
      input.runnerOverride
        ? `Install ${input.runnerOverride} and make sure it's on your PATH, or pick a different runner in Settings.`
        : "Install one and make sure it's on your PATH. Try `claude --version` or `codex --version` in a terminal.",
    );
    return;
  }

  const seed = buildSkeleton({
    repoPath: input.repo.localPath,
    agentName: input.agentName,
    scope: input.scope,
    ...(input.featureName ? { featureName: input.featureName } : {}),
  });

  const runId = `plan-${ulid().slice(-8).toLowerCase()}`;
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
    const focusFiles = input.focusOnChangedOrUncovered ? await loadFocusFiles(input.repo.id) : [];
    const stdin = generatorPrompt(input, seed, focusFiles);
    const abort = new AbortController();
    // Throttle "Drafting: …" toast updates: chatty models emit hundreds of
    // stdout chunks during reasoning, and we don't want a re-render per chunk.
    let lastDraftTickAt = 0;
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
        if (now - lastDraftTickAt < 500) return;
        lastDraftTickAt = now;
        advanceStage(jobId, 'drafting', `Drafting: ${text}…`);
      },
      abort: abort.signal,
    });

    if (result.timedOut) {
      finishFailed(
        jobId,
        `Generation timed out after ${Math.round(GEN_TIMEOUT_MS / 60_000)} minutes.`,
        'The codebase may be large. Try a feature-scoped plan instead of whole-app.',
      );
      return;
    }
    if (result.exitCode !== 0) {
      // `claude` prints model-rejection errors ("model does not exist") to
      // stdout, not stderr — surface whichever stream actually carries the
      // message so the user sees the real failure instead of a generic hint.
      const stderr = result.stderr.trim();
      const stdoutTail = result.stdout.trim().split('\n').slice(-3).join(' | ').slice(-400);
      const hint =
        stderr.length > 0
          ? stderr.slice(-400)
          : stdoutTail || `Run \`${runnerKind} --version\` to verify your installation.`;
      finishFailed(jobId, `${runnerKind} exited ${result.exitCode ?? '?'}.`, hint);
      return;
    }

    advanceStage(jobId, 'drafting', 'Parsing model output…');
    const blocks = extractBlocks(result.stdout);
    if (!blocks || blocks.length === 0) {
      finishFailed(
        jobId,
        'The model did not return a parseable test plan.',
        'Check that your runner is configured correctly. You can retry from the toast.',
      );
      return;
    }

    advanceStage(jobId, 'writing');
    const plan = createPlan({
      repoPath: input.repo.localPath,
      agentName: input.agentName,
      scope: input.scope,
      ...(input.featureName ? { featureName: input.featureName } : {}),
      blocks,
      generatedBy: runnerKind,
    });

    const { broadcast } = await import('../ipc/bus');
    broadcast({ type: 'testPlans.changed', repoId: input.repo.id });
    finishDone(jobId, plan.frontmatter.id);
  } finally {
    await destroyWorktree(input.repo.localPath, wt.worktreePath).catch(() => undefined);
  }
}

async function pickInstalledRunner(
  repo: Repo,
  override?: 'claude' | 'codex',
): Promise<'claude' | 'codex' | null> {
  // When the user explicitly picks a runner in the modal, only check that
  // one — falling back silently to a different CLI would surprise them. When
  // no override is given, fall through Settings → repo column for the
  // preferred order, but still try the alternate as a backup.
  if (override) {
    const runner = override === 'codex' ? new CodexRunner() : new ClaudeCodeRunner();
    const status = await runner.isInstalled();
    return status.ok ? override : null;
  }
  const preferred = effectiveDefaultRunner(repo);
  const order: ('claude' | 'codex')[] =
    preferred === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const kind of order) {
    const runner = kind === 'codex' ? new CodexRunner() : new ClaudeCodeRunner();
    const status = await runner.isInstalled();
    if (status.ok) return kind;
  }
  return null;
}

function claudeArgs(modelOverride?: string): string[] {
  // `--model` is added only when the user configured a Claude model (Settings)
  // or supplied a per-generation override. Blank everywhere = claude picks.
  const args = ['-p', '--system-prompt', GEN_SYSTEM_PROMPT];
  const model = resolveRunnerModel('claude', modelOverride);
  if (model) args.splice(0, 0, '--model', model);
  return args;
}

function codexArgs(modelOverride?: string): string[] {
  // Single source of truth — same builder the orchestrator uses, so override
  // semantics + the `--skip-git-repo-check` worktree fix stay in lockstep.
  return buildCodexExecArgs({
    sandbox: 'read-only',
    reasoning: 'high',
    modelOverride,
  });
}

const GEN_SYSTEM_PROMPT = [
  'You are a senior QA engineer producing a structured test plan for a codebase.',
  'You read code, identify the actual user-facing features, and produce a per-feature test plan.',
  '',
  'You return STRICTLY the JSON object specified in the user message between',
  'BEGIN_TEST_PLAN and END_TEST_PLAN markers, no commentary, no surrounding',
  'narrative. The JSON object has the exact shape specified — do not add fields,',
  'do not omit fields. Place test plan content (titles, expected, repro) in the',
  'JSON; do not write prose outside the markers.',
].join(' ');

function generatorPrompt(
  input: GenerateInput,
  seed: TestPlanBlock[],
  focusFiles: FocusFile[],
): string {
  const scopeDesc =
    input.scope === 'feature' && input.featureName
      ? `Focus narrowly on the "${input.featureName}" feature. Read the codebase to find the files that implement it. Produce sections that cover its happy path, validation, edge cases, network/IO failures, and persistence.`
      : `Produce a comprehensive test plan covering EVERY user-facing feature of this codebase. Read the repo (src/, app/, packages/, README.md, package.json) to identify the real features. Each top-level user-facing area gets its own section. Always include a "Smoke" section first.`;

  const seedSummary = seed
    .map((b) => (b.kind === 'section' ? `## ${b.title}` : `- [ ] ${b.title}`))
    .join('\n');

  const focusBlock = focusFiles.length
    ? [
        '',
        '## Coverage focus (the user opted into "focus on what changed or isn\'t covered")',
        '',
        'Bias this plan toward the files below — they are either uncovered, recently churned',
        'since the last passing QA sweep, or carry open findings. Skew section selection and case',
        'titles to exercise the features these files implement. You may include a Smoke section,',
        'but do not waste cases on areas that are already heavily covered and stable.',
        '',
        ...focusFiles.map((f) => `- \`${f.path}\` — ${describeReason(f)}`),
      ].join('\n')
    : '';

  return [
    `# Task: produce a comprehensive test plan for ${input.repo.githubFullName}`,
    '',
    `Target QA agent: ${input.agentName}`,
    `Repository root: ${input.repo.localPath} (current working directory)`,
    '',
    '## Scope',
    scopeDesc,
    focusBlock,
    '',
    '## Hard requirements',
    `- Minimum ${input.scope === 'feature' ? 2 : 5} sections, target ${input.scope === 'feature' ? 3 : 8} sections.`,
    '- Minimum 4 cases per section, target 5–8.',
    '- Maximum 60 cases total — pick the highest-value cases first.',
    '- Each case has a CONCRETE title (under 14 words), an Expected outcome, and a Repro hint.',
    '- "Login works" is not acceptable — name the route, the field IDs, the success state.',
    '- Severity is one of P0 (must work), P1 (should work), P2 (nice to have).',
    '- Each case carries `scope` — an array of 1–3 lowercase labels naming the',
    '  code areas the case exercises (e.g. ["auth"], ["checkout","billing"],',
    '  ["onboarding"]). Use the section name as a fallback if no narrower label',
    '  fits. Labels feed the Coverage screen so the user can see which files',
    '  are tested vs. dark, so be precise.',
    '',
    '## Heuristic seed (we walked the repo for you — replace with real cases)',
    '```',
    seedSummary,
    '```',
    '',
    '## Investigation steps (do these BEFORE writing)',
    '1. Read README.md and package.json to understand what the product is.',
    '2. List the entry points (src/index*, src/main/*, app/*, src/renderer/screens/*, src/pages/*, src/routes/*).',
    '3. For each user-facing feature you identify, plan 4–8 concrete test cases.',
    '4. Always include a "Smoke" section with boot, navigation, loading/error reachability.',
    '',
    '## Output format (STRICT)',
    'Emit ONLY the following block, nothing else:',
    '',
    'BEGIN_TEST_PLAN',
    '{',
    '  "blocks": [',
    '    { "kind": "section", "title": "Smoke" },',
    '    { "kind": "case", "title": "App boots without uncaught errors", "expected": "...", "repro": "...", "severity": "P0", "scope": ["smoke"] },',
    '    { "kind": "section", "title": "<Feature 1>" },',
    '    { "kind": "case", "title": "...", "expected": "...", "repro": "...", "severity": "P0", "scope": ["<feature-1>"] }',
    '  ]',
    '}',
    'END_TEST_PLAN',
  ].join('\n');
}

/**
 * Extract the test plan JSON from the LLM's stdout. Tries multiple shapes:
 *   1. BEGIN_TEST_PLAN ... END_TEST_PLAN markers (the system prompt asks for this).
 *   2. ```json ... ``` fenced block.
 *   3. Largest balanced { ... } object with a `blocks` array.
 */
export function extractBlocks(stdout: string): TestPlanBlock[] | null {
  const candidates: string[] = [];

  const marker = /BEGIN_TEST_PLAN\s*([\s\S]*?)\s*END_TEST_PLAN/.exec(stdout);
  if (marker) candidates.push(marker[1]!);

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(stdout);
  if (fence) candidates.push(fence[1]!);

  const balanced = findLargestJsonObject(stdout);
  if (balanced) candidates.push(balanced);

  for (const raw of candidates) {
    const blocks = tryParseBlocks(raw);
    if (blocks && blocks.length > 0) return blocks;
  }
  return null;
}

function tryParseBlocks(raw: string): TestPlanBlock[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (parsed as { blocks?: unknown }).blocks;
  if (!Array.isArray(arr)) return null;

  const blocks: TestPlanBlock[] = [];
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (o.kind === 'section' && typeof o.title === 'string') {
      blocks.push({ kind: 'section', id: ulid(), title: o.title.trim() });
      continue;
    }
    if (o.kind === 'case' && typeof o.title === 'string') {
      const sev =
        typeof o.severity === 'string' && /^P[012]$/.test(o.severity)
          ? (o.severity as 'P0' | 'P1' | 'P2')
          : null;
      const scope = Array.isArray(o.scope)
        ? o.scope.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : null;
      blocks.push({
        kind: 'case',
        id: ulid(),
        title: o.title.trim(),
        expected: typeof o.expected === 'string' ? o.expected.trim() : null,
        repro: typeof o.repro === 'string' ? o.repro.trim() : null,
        severity: sev,
        scope: scope && scope.length > 0 ? scope : null,
      });
    }
  }
  return blocks;
}

/** Naive but useful: find the largest top-level balanced { ... } substring. */
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
        if (candidate.includes('"blocks"') && (!best || candidate.length > best.length)) {
          best = candidate;
        }
        start = -1;
      }
    }
  }
  return best;
}

/**
 * Build the focus list for the generator prompt. Best-effort: if the
 * coverage report fails to compute (no git repo yet, etc.), we silently
 * return [] — focus mode just becomes a no-op rather than blocking the
 * generation.
 */
async function loadFocusFiles(repoId: string): Promise<FocusFile[]> {
  try {
    const report = await buildCoverageReport(repoId);
    return pickFocusFiles(report, 30);
  } catch {
    return [];
  }
}

function describeReason(f: FocusFile): string {
  switch (f.reason) {
    case 'open-findings':
      return `${f.findingsCount} open finding${f.findingsCount === 1 ? '' : 's'}`;
    case 'uncovered-with-churn':
      return `uncovered, ${f.churnSinceLastPass} commit${f.churnSinceLastPass === 1 ? '' : 's'} since last pass`;
    case 'churn-since-pass':
      return `${f.churnSinceLastPass} commit${f.churnSinceLastPass === 1 ? '' : 's'} since last pass`;
    case 'uncovered':
      return `no test case targets this file yet`;
  }
}

/**
 * Synchronous variant retained for compatibility with the existing IPC and
 * vitest tests. Internally just awaits the async job.
 *
 * Renderer code SHOULD use the async path (testPlans:generate returns a
 * jobId, watch the bus for progress) — this synchronous helper is here for
 * tests and any internal caller that still wants a plan-or-throw shape.
 */
export async function generateTestPlan(input: GenerateInput): Promise<TestPlan> {
  // Reuse the async pipeline by spinning a job and waiting for it inline.
  // This keeps the LLM logic in one place.
  const jobId = startGenerationJob(input);
  return await waitForJob(jobId, input);
}

async function waitForJob(jobId: string, input: GenerateInput): Promise<TestPlan> {
  const { addInProcessListener } = await import('../ipc/bus');
  return new Promise((resolve, reject) => {
    const unsubscribe = addInProcessListener((evt) => {
      if (evt.type !== 'testPlanGeneration.progress') return;
      if (evt.job.jobId !== jobId) return;
      if (evt.job.stage === 'done' && evt.job.planId) {
        unsubscribe();
        import('./store').then(({ getPlan }) => {
          try {
            resolve(getPlan(input.repo.localPath, evt.job.planId!));
          } catch (e) {
            reject(e);
          }
        });
      } else if (evt.job.stage === 'failed') {
        unsubscribe();
        reject(
          new ObeliskError(
            'INTERNAL',
            evt.job.errorMessage ?? 'generation failed',
            evt.job.errorHint ?? undefined,
          ),
        );
      }
    });
  });
}

export class TestPlanGenerationError extends ObeliskError {}
