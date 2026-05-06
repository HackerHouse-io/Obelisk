import { ulid } from 'ulid';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo, TestPlanBlock, TestPlanScope } from '../../shared/types';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';
import { spawnAgentCli } from '../runners/spawn';
import { runnerEnv } from '../runners/env';
import { createWorktree, destroyWorktree } from '../git/worktree';
import { buildSkeleton } from './heuristic';
import { createPlan } from './store';
import type { TestPlan } from '../../shared/types';

/**
 * Generate a test plan for a repo.
 *
 * Flow:
 *   1. Build the heuristic skeleton from the on-disk repo layout.
 *   2. If a CLI runner is installed, ask it to flesh out the skeleton with
 *      product-specific cases. Output is a strict JSON contract; any parse
 *      or runtime failure falls back to the skeleton.
 *   3. Persist the resulting plan to qa/test-plans/<id>.md.
 *
 * The skeleton path is the safety net: a developer with no runner installed
 * still gets a workable starting plan they can edit. The LLM path layers
 * specificity on top.
 */
const GEN_TIMEOUT_MS = 4 * 60 * 1000;

export interface GenerateInput {
  repo: Repo;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName?: string;
}

export async function generateTestPlan(input: GenerateInput): Promise<TestPlan> {
  const skeleton = buildSkeleton({
    repoPath: input.repo.localPath,
    agentName: input.agentName,
    scope: input.scope,
    ...(input.featureName ? { featureName: input.featureName } : {}),
  });

  const llm = await tryLlmRefine(input, skeleton).catch(() => null);
  const blocks = llm?.blocks ?? skeleton;
  const generatedBy = llm?.runner ?? 'heuristic';

  return createPlan({
    repoPath: input.repo.localPath,
    agentName: input.agentName,
    scope: input.scope,
    ...(input.featureName ? { featureName: input.featureName } : {}),
    blocks,
    generatedBy,
  });
}

interface RefineResult {
  blocks: TestPlanBlock[];
  runner: 'claude' | 'codex';
}

async function tryLlmRefine(
  input: GenerateInput,
  skeleton: TestPlanBlock[],
): Promise<RefineResult | null> {
  const runner = await pickInstalledRunner();
  if (!runner) return null;

  const runId = `plan-${ulid().slice(-8).toLowerCase()}`;
  const wt = await createWorktree({
    repoPath: input.repo.localPath,
    repoId: input.repo.id,
    runId,
    baseBranch: input.repo.defaultBranch,
  });

  try {
    const args = runner === 'codex' ? codexArgs() : claudeArgs();
    const stdin = generatorPrompt(input, skeleton);
    const abort = new AbortController();
    const result = await spawnAgentCli({
      command: runner,
      args,
      cwd: wt.worktreePath,
      env: runnerEnv(),
      stdin,
      timeoutMs: GEN_TIMEOUT_MS,
      onAudit: () => undefined,
      abort: abort.signal,
    });

    if (result.timedOut || result.exitCode !== 0) return null;
    const blocks = parseBlocksJson(result.stdout);
    if (!blocks || blocks.length === 0) return null;
    return { blocks, runner };
  } finally {
    await destroyWorktree(input.repo.localPath, wt.worktreePath).catch(() => undefined);
  }
}

async function pickInstalledRunner(): Promise<'claude' | 'codex' | null> {
  const claude = await new ClaudeCodeRunner().isInstalled();
  if (claude.ok) return 'claude';
  const codex = await new CodexRunner().isInstalled();
  if (codex.ok) return 'codex';
  return null;
}

function claudeArgs(): string[] {
  return ['-p', '--system-prompt', GEN_SYSTEM_PROMPT];
}

function codexArgs(): string[] {
  return ['exec', '--model', 'gpt-5', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="high"'];
}

const GEN_SYSTEM_PROMPT =
  'You are a senior QA engineer producing a structured test plan for a codebase. You return strictly the requested JSON, no commentary, no surrounding markdown fences other than the BEGIN/END markers.';

function generatorPrompt(input: GenerateInput, skeleton: TestPlanBlock[]): string {
  const scopeDesc =
    input.scope === 'feature' && input.featureName
      ? `Focus narrowly on the "${input.featureName}" feature. Read the codebase to find the files that implement it. Produce sections that cover its happy path, edge cases, validation, and failure modes.`
      : `Produce a test plan covering every user-facing feature of this codebase. Read the repo layout (src/, app/, lib/) to identify features. Produce one section per feature plus a "Smoke" section.`;

  const seedSummary = skeleton
    .map((b) =>
      b.kind === 'section' ? `## ${b.title}` : `- [ ] ${b.title}`,
    )
    .join('\n');

  return [
    `# Task: produce a test plan for ${input.repo.githubFullName}`,
    '',
    `Target agent: ${input.agentName}`,
    '',
    `## Scope`,
    scopeDesc,
    '',
    `## Heuristic skeleton (replace with codebase-specific cases)`,
    '```',
    seedSummary,
    '```',
    '',
    `## Rules`,
    `- Sections name a feature. Cases are concrete, observable behaviors.`,
    `- Each case has a short title (under 12 words), an Expected outcome, and a Repro hint.`,
    `- 3 to 8 cases per section. 4 to 12 sections total. Cover P0/P1 first.`,
    `- Severity is one of P0 (must work), P1 (should work), P2 (nice to have).`,
    `- Be specific to THIS codebase. "Login works" is not useful — name the route, the fields, the success state.`,
    '',
    `## Output format (STRICT)`,
    'Emit exactly the following, nothing else:',
    '',
    'BEGIN_TEST_PLAN',
    '{',
    '  "blocks": [',
    '    { "kind": "section", "title": "..." },',
    '    { "kind": "case", "title": "...", "expected": "...", "repro": "...", "severity": "P0" }',
    '  ]',
    '}',
    'END_TEST_PLAN',
  ].join('\n');
}

function parseBlocksJson(stdout: string): TestPlanBlock[] | null {
  const m = /BEGIN_TEST_PLAN\s*([\s\S]*?)\s*END_TEST_PLAN/.exec(stdout);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (parsed as { blocks?: unknown }).blocks;
  if (!Array.isArray(arr)) return null;

  const blocks: TestPlanBlock[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (o.kind === 'section' && typeof o.title === 'string') {
      blocks.push({ kind: 'section', id: ulid(), title: o.title.trim() });
      continue;
    }
    if (o.kind === 'case' && typeof o.title === 'string') {
      const sev = typeof o.severity === 'string' && /^P[012]$/.test(o.severity) ? (o.severity as 'P0' | 'P1' | 'P2') : null;
      blocks.push({
        kind: 'case',
        id: ulid(),
        title: o.title.trim(),
        expected: typeof o.expected === 'string' ? o.expected.trim() : null,
        repro: typeof o.repro === 'string' ? o.repro.trim() : null,
        severity: sev,
      });
      continue;
    }
  }
  return blocks;
}

/** Used by IPC error reporting; bubbles up the originating cause unchanged. */
export class TestPlanGenerationError extends ObeliskError {}
