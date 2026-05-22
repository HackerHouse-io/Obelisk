import type { AgentName, FindingSeverity, RunnerKind, SafetyMode } from '../../shared/types';

export interface TaskPayload {
  /** Stable reference, e.g. "issue#142" or "pr#211" or "manual:run-1". */
  ref: string;
  /** What kind of task this is — drives the agent's output decision. */
  kind: 'bug' | 'feature' | 'review' | 'sweep' | 'qa' | 'manual';
  /**
   * One-line, user-facing label for this run. Surfaced in the run-started
   * toast, Mission Control card title, and Archive list — keep it short
   * (≤120 chars, single line). Optional: if omitted the orchestrator
   * derives one from the first line of `context`.
   */
  summary?: string;
  /** Free-form context: GitHub issue body, PR diff link, manual prompt, etc. */
  context: string;
  /** GitHub issue or PR number, if applicable. */
  githubNumber?: number;
  /**
   * The full test plan markdown the agent must execute, if assigned. Set by
   * QA agents (qa-hunter, manual-qa, ios-qa-pilot) when the renderer dispatches
   * `agents:run` with `taskId='plan:<id>'`. The compiler splices this into the
   * user message as an "Assigned test plan" section so the agent can read it
   * verbatim.
   */
  assignedPlan?: AssignedPlan;
}

export interface AssignedPlan {
  id: string;
  name: string;
  /** Pre-rendered markdown (frontmatter stripped). */
  body: string;
  /**
   * Helps the agent index findings back to specific cases.
   * `slotId` is a deterministic short label (`C1`, `C2`, …) assigned in
   * document order. The orchestrator accepts either the ULID `caseId` or
   * the friendly `slotId` in CASE_* markers, so an agent that quotes the
   * visible slot label instead of the full ULID still resolves.
   *
   * `expected`/`repro`/`severity` are mirrored from the plan block so the
   * orchestrator can synthesize a fallback Finding (with `synthetic: true`)
   * when the agent marks a case `CASE_FAIL` or persistent `CASE_INCONCLUSIVE`
   * but doesn't emit one of its own. Without this, a failed case ends up
   * with no preview the user can file from.
   */
  caseRefs: {
    sectionTitle: string;
    caseId: string;
    slotId: string;
    caseTitle: string;
    expected: string | null;
    repro: string | null;
    severity: FindingSeverity | null;
  }[];
}

export interface RepoSummary {
  fullName: string;
  defaultBranch: string;
  /** Path to the worktree the agent will run inside. */
  worktreePath: string;
  /** Trimmed README excerpt (≤ 1500 chars). */
  readmeExcerpt: string;
  /** Detected primary language(s) and their entrypoints (top 5). */
  languages: string[];
  /** Detected package managers / test runners. */
  toolchain: string[];
  /** Files changed since this agent's last successful run (or empty on first run). */
  changedFilesSinceLastRun: string[];
  /** Top-level QA Playbook summary (or empty if no `qa/` exists). */
  qaPlaybookSummary: string;
}

export interface Permissions {
  /** Mirrors the safety mode but expressed as discrete capabilities. */
  mode: SafetyMode;
  canCreateIssues: boolean;
  canOpenPRs: boolean;
  canMergePRs: boolean;
}

export interface CompileInput {
  agent: import('./agent-loader').AgentDefinition;
  skills: import('./skill-loader').SkillDefinition[];
  task: TaskPayload;
  repo: RepoSummary;
  runnerKind: RunnerKind;
  permissions: Permissions;
  /**
   * Per-call model override. `undefined` falls through to Settings/CLI default;
   * an explicit non-empty string is passed to the runner verbatim; an empty
   * string forces the CLI default (no --model flag — required for ChatGPT
   * Codex sign-ins).
   */
  modelOverride?: string;
}

export interface AttachmentFile {
  /**
   * Relative path from the worktree root, e.g. `.claude/skills/<name>/SKILL.md`.
   * Codex layout typically has zero attachments because skills are inlined.
   */
  path: string;
  contents: string;
}

export interface CompiledPrompt {
  systemPrompt: string;
  userMessage: string;
  attachments: AttachmentFile[];
  /** CLI flags, e.g. ['--codex-model=gpt-5', '--codex-reasoning-effort=high']. */
  runnerArgs: string[];
  /** SHA-256 of the canonical input payload. Stable for identical inputs. */
  contentHash: string;
}

export interface CompilerPaths {
  /** Path to <repo>/agents/, if the connected repo overrides agents. */
  repoAgentsDir?: string;
  /** Path to <repo>/skills/, if the connected repo overrides skills. */
  repoSkillsDir?: string;
  /** Path to the built-in agents catalog (this repo's `agents/`). */
  builtinAgentsDir: string;
  /** Path to the built-in skill catalog (this repo's `skills/`). */
  builtinSkillsDir: string;
}

export interface CompileOptions {
  agentName: AgentName;
  /** Override agent.defaultRunner if a per-agent runner is configured. */
  runnerOverride?: RunnerKind;
  /**
   * Per-call model override. See `CompileInput.modelOverride` for the
   * three-way semantics (undefined / empty / explicit).
   */
  modelOverride?: string;
  task: TaskPayload;
  repo: RepoSummary;
  permissions: Permissions;
  paths: CompilerPaths;
}
