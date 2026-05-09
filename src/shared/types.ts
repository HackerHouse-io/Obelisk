/**
 * Cross-process types. Source of truth: docs/TECH_DESIGN.md §3.
 * Adding a new IPC channel: declare it in IpcChannels (this file), register
 * a handler in src/main/ipc/register.ts, and bump the closed enum in
 * src/shared/errors.ts if a new error code is needed.
 */

export type SafetyMode = 'observe' | 'issues' | 'prs' | 'automerge';
export type RunnerKind = 'claude' | 'codex';
export type RunState =
  | 'queued'
  | 'running'
  | 'publishing'
  | 'done'
  | 'failed'
  | 'paused'
  | 'cancelled';
export type AgentName =
  | 'qa-hunter'
  | 'manual-qa'
  | 'bug-fixer'
  | 'feature-builder'
  | 'pr-reviewer'
  | 'ios-qa-pilot';
export type AttributionMode = 'user' | 'bot' | 'custom';

export type ISO = string;

export interface AuthStatus {
  signedIn: boolean;
  login?: string;
  scope?: string[];
}

export interface Repo {
  id: string;
  githubFullName: string;
  localPath: string;
  defaultBranch: string;
  mode: SafetyMode;
  defaultRunner: RunnerKind;
  connectedAt: ISO;
}

export interface AgentPermissions {
  readCode: boolean;
  runTests: boolean;
  createIssues: boolean;
  draftPrs: boolean;
  merge: boolean;
}

export type ScheduleMode = 'event' | 'recurring' | 'cron' | 'manual';

export interface ScheduleConfig {
  mode: ScheduleMode;
  /** Recurring */
  every?: number;
  unit?: 'minute' | 'hour' | 'day' | 'week';
  at?: string; // 'HH:MM'
  days?: [number, number, number, number, number, number, number]; // Mon..Sun
  tz?: string;
  /** Event */
  events?: string[];
  /** Cron */
  cron?: string;
  /** Guardrails */
  maxConcurrent?: number;
  maxPerDay?: number;
  quietStart?: string;
  quietEnd?: string;
  pauseLowCredit?: boolean;
}

export interface Agent {
  id: string;
  repoId: string;
  /** Type — qa-hunter / bug-fixer / etc. Multiple instances share the same name. */
  name: AgentName;
  /** User-editable label distinguishing instances of the same type. */
  displayName: string;
  enabled: boolean;
  runnerOverride: RunnerKind | null;
  modelOverride: string | null;
  scheduleCron: string | null;
  /** Mode-aware schedule blob; null until the user opens the segmented editor. */
  schedule: ScheduleConfig | null;
  timeoutMs: number;
  permissions: AgentPermissions;
  createdAt: ISO;
  /**
   * Computed at the IPC boundary (not stored on the DB row):
   * - `false` for singleton types (qa-hunter, manual-qa); the renderer disables
   *   "+ Add another" for these.
   * - `true` for types that support multiple instances.
   */
  multiInstance: boolean;
  /**
   * Computed at the IPC boundary (not stored on the DB row):
   * - `null` when the agent is manual-only (e.g. iOS QA Pilot) or its cron
   *   expression is invalid.
   * - Otherwise, the next time the scheduler will dispatch this agent given
   *   its last run (or the repo's `connectedAt` if it has never run).
   */
  nextFireAt?: ISO | null;
  /** Last `started_at` for any run of this agent, regardless of outcome. */
  lastRunAt?: ISO | null;
  /**
   * Default test plan for QA agents. When set, Run now (and scheduled
   * runs) dispatch with this plan; if the plan is later deleted or no
   * longer applies, the field is null and the agent falls back to
   * single-plan resolution.
   */
  defaultPlanId?: string | null;
}

export interface Run {
  id: string;
  repoId: string;
  agentName: AgentName;
  /** Instance that owned this run. Null on legacy rows from before multi-instance. */
  agentId: string | null;
  state: RunState;
  startedAt: ISO | null;
  finishedAt: ISO | null;
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  taskRef: string | null;
  /**
   * Snapshot of the human-readable task title at claim time. For Bug Fixer
   * / Feature Builder this is the GitHub issue title (or manual backlog
   * row title); for QA agents it's the test plan name; for PR Reviewer the
   * PR title. Null on rows from before migration 008.
   */
  taskContext: string | null;
  runnerUsed: RunnerKind;
  fallbackUsed: boolean;
  outputSummary: string | null;
  errorCode: string | null;
}

export interface BugFixerHealth {
  /** ISO timestamp marking the start of the rolling 7-day window. */
  windowStart: ISO;
  prsOpened: number;
  runsDone: number;
  runsFailed: number;
  rebaseSuccess: number;
  rebaseConflict: number;
  rebaseError: number;
  rebaseEscalated: number;
  ciRetrySuccess: number;
  ciRetryFailed: number;
  ciRetryEscalated: number;
  /** A sibling Obelisk install was already working an issue we tried to claim. */
  crossInstallSkipped: number;
  /** Stale `obelisk:in-progress` labels cleared by the reaper. */
  claimSignalReaped: number;
}

export interface AuditLine {
  id: number;
  runId: string;
  at: ISO;
  /**
   * Discriminator for the payload shape. Common values:
   * - `agent_event` — payload is an {@link AgentEvent} (Claude Code structured stream).
   * - `stdout` / `stderr` — payload is a raw string line (Codex, plain text fallback).
   * - `state` — orchestrator stage transition.
   * - `case_progress`, `reasoning`, `evidence_check` — orchestrator markers.
   */
  kind: string;
  payload: unknown;
}

/**
 * Structured event extracted from Claude Code's `--output-format stream-json`.
 * Stored as the payload on an {@link AuditLine} with `kind: 'agent_event'`,
 * letting Mission Control render a step-based timeline instead of raw JSONL.
 */
export type AgentEvent =
  | { type: 'session_init'; model?: string; cwd?: string; tools?: string[]; sessionId?: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      ok: boolean;
      content: string;
      isError?: boolean;
    }
  | { type: 'status'; subtype?: string; raw: unknown }
  | {
      type: 'result';
      ok: boolean;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
      text?: string;
    };

export interface BacklogItem {
  id: string;
  repoId: string;
  source: 'gh_issue' | 'manual';
  githubIssue: number | null;
  title: string;
  kind: 'bug' | 'feature';
  priorityLabel: 'P0' | 'P1' | 'P2' | null;
  userPinRank: number | null;
  agentOverride: AgentName | null;
  runnerOverride: RunnerKind | null;
  inProgressRun: string | null;
}

export interface PlaybookFile {
  path: string;
  contents: string;
}

export interface Playbook {
  files: PlaybookFile[];
  draft: boolean;
  /** ISO timestamp of the last bootstrap or regenerate run, or null if unknown. */
  generatedAt: ISO | null;
  /** Detected framework slug from the last generation, or null if unknown. */
  framework: string | null;
}

export type PlaybookRegenMode = 'quick' | 'deep';

/* ---------- Test plans ---------- */

export type TestPlanScope = 'whole-app' | 'feature';

export interface TestPlanFrontmatter {
  id: string;
  name: string;
  scope: TestPlanScope;
  feature: string | null;
  /**
   * QA agents this plan can be run by. A plan defines a set of test cases;
   * different QA agents (qa-hunter, manual-qa, ios-qa-pilot) are different
   * ways of executing those cases, so the same plan can apply to many.
   * Always non-empty; defaults to `['qa-hunter']` when unspecified.
   */
  agentNames: AgentName[];
  generatedAt: ISO;
  generatedBy: 'claude' | 'codex' | 'heuristic' | 'manual';
  version: number;
}

export type TestPlanBlock =
  | { kind: 'section'; id: string; title: string }
  | {
      kind: 'case';
      id: string;
      title: string;
      expected: string | null;
      repro: string | null;
      severity: FindingSeverity | null;
      /**
       * Coverage labels — what code area this case targets. The labels are
       * resolved to file globs via `qa/coverage-map.md` in the repo. When
       * absent, the case is "untargeted" and contributes to a residual
       * coverage bucket on the Coverage screen.
       */
      scope: string[] | null;
    };

export interface TestPlan {
  frontmatter: TestPlanFrontmatter;
  blocks: TestPlanBlock[];
  /** Convenience aggregates the renderer uses without re-walking blocks. */
  caseCount: number;
  filePath: string;
  /** Last-modified time of the on-disk file (mtime), used for "edited 2m ago". */
  updatedAt: ISO;
}

export interface TestPlanSummary {
  id: string;
  name: string;
  scope: TestPlanScope;
  feature: string | null;
  agentNames: AgentName[];
  caseCount: number;
  generatedAt: ISO;
  updatedAt: ISO;
}

export type TestPlanGenerationStage =
  | 'queued'
  | 'spawning'
  | 'reading'
  | 'drafting'
  | 'writing'
  | 'done'
  | 'failed';

export interface TestPlanGenerationJob {
  jobId: string;
  repoId: string;
  agentName: AgentName;
  scope: TestPlanScope;
  feature: string | null;
  stage: TestPlanGenerationStage;
  /** Human-readable status line, advances with the stage. */
  status: string;
  startedAt: ISO;
  finishedAt: ISO | null;
  /** Set on stage='done'. */
  planId: string | null;
  /** Set on stage='failed'. */
  errorMessage: string | null;
  errorHint: string | null;
}

export interface Settings {
  defaultRunner: RunnerKind;
  /**
   * Default model name passed to the Claude Code CLI. Empty string means
   * "let the CLI use its own default" — preferred when the user hasn't
   * explicitly chosen, since model identifiers rotate frequently and
   * pinning one the user's account doesn't license breaks the call.
   */
  claudeModel: string;
  /** Default model name passed to the Codex CLI. Same semantics as `claudeModel`. */
  codexModel: string;
  attributionMode: AttributionMode;
  cloudExecutionEnabled: boolean; // v0.1: always false
}

export interface EvidenceItem {
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
}

export type FindingSeverity = 'P0' | 'P1' | 'P2';

/**
 * Per-case execution state for the live "Plan progress" tab in Mission Control.
 *
 *   queued        — the agent hasn't started this case yet
 *   running       — agent emitted `CASE_START <id>` and hasn't finished it
 *   passed        — agent emitted `CASE_PASS <id>` (or no finding referenced it after a done run)
 *   failed        — agent emitted `CASE_FAIL <id>` or filed a finding against this case_id
 *   inconclusive  — agent emitted `CASE_INCONCLUSIVE <id>` (couldn't determine)
 *   skipped       — run terminated (cancelled/failed) before the agent reached this case
 */
export type CaseProgressState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'skipped';

export interface PreviewEvidence {
  /** Stable artifact id from evidence_artifacts. Used to build obelisk:// URLs. */
  id: string;
  kind: string;
  basename: string;
  bytes: number;
}

export interface PreviewedFinding {
  /** audit_log row id. Stable cursor for list pagination + the action key. */
  id: number;
  runId: string;
  agentName: AgentName;
  at: ISO;
  title: string;
  body: string;
  labels: string[];
  severity: FindingSeverity | null;
  evidence: PreviewEvidence[];
  /** When the user has manually published this finding to GitHub already. */
  published: { issueNumber: number; htmlUrl: string; at: ISO } | null;
  /** When the user dismissed this finding (false-positive). */
  dismissed: boolean;
}

/* ---------- iOS QA Pilot ---------- */

export type QaFlowStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'outdated';

export interface QaFlow {
  flowId: string;
  repoId: string;
  title: string;
  sourcePath: string;
  status: QaFlowStatus;
  cycle: number;
  lastRunId: string | null;
  lastVerifiedAt: ISO | null;
  findingCount: number;
  /** If this flow_id was migrated from a previous id, the predecessor. */
  renamedFromOldId?: string;
}

export type DoctorCheckLevel = 'green' | 'yellow' | 'red';
export interface DoctorCheck {
  id: string;
  label: string;
  level: DoctorCheckLevel;
  detail: string;
  remediation?: string;
}
export interface DoctorReport {
  overall: DoctorCheckLevel;
  checks: DoctorCheck[];
  checkedAt: ISO;
  setupAt: ISO | null;
}

export type DoctorSetupStep =
  | 'install-appium'
  | 'install-xcuitest'
  | 'bootstrap-pool'
  | 'scaffold-config';

/* ---------- IPC channel map ---------- */

export interface IpcMap {
  // Auth
  'auth:status': { req: void; res: AuthStatus };
  'auth:signIn': {
    req: void;
    res: { verificationUri: string; userCode: string; expiresInSeconds: number };
  };
  'auth:complete': { req: void; res: { login: string; scope: string[] } };
  'auth:upgradeScope': { req: { to: SafetyMode }; res: { scope: string[] } };
  'auth:signInWithToken': { req: { token: string }; res: { login: string; scope: string[] } };
  'auth:capabilities': { req: void; res: { deviceFlow: boolean } };
  'auth:signOut': { req: void; res: { ok: true } };

  // Repos
  'repos:list': { req: void; res: Repo[] };
  'repos:connect': { req: { localPath?: string; githubFullName?: string }; res: Repo };
  'repos:setMode': { req: { repoId: string; mode: SafetyMode }; res: Repo };
  /**
   * Per-repo bug-fixer / feature-builder knobs. Returns the current
   * effective values after the optional patch is applied. Pass any subset
   * of the fields to update them; omitted fields stay as-is.
   */
  'repos:bugFixerSettings': {
    req: {
      repoId: string;
      patch?: { mergeQueueEnabled?: boolean; cap?: number };
    };
    res: { mergeQueueEnabled: boolean; cap: number };
  };
  'repos:pickFolder': { req: void; res: { path: string | null } };
  'repos:listGitHubRepos': {
    req: void;
    res: {
      fullName: string;
      defaultBranch: string;
      private: boolean;
      description: string | null;
    }[];
  };

  // Allowlist
  'allowlist:list': {
    req: { repoId: string };
    res: { login: string; addedAt: ISO; addedBy: string }[];
  };
  'allowlist:add': { req: { repoId: string; login: string }; res: { ok: true } };
  'allowlist:remove': { req: { repoId: string; login: string }; res: { ok: true } };

  // Agents
  'agents:list': { req: { repoId: string }; res: Agent[] };
  'agents:run': {
    req: {
      agentId: string;
      taskId?: string;
      /** One-shot override for this run only — does not persist on the agent row. */
      runnerOverride?: RunnerKind;
      /**
       * One-shot model override for this run only.
       * - non-empty string → that exact model id (e.g. "opus-4-7")
       * - empty string / omitted → fall through to agent row override → Settings → CLI default
       */
      modelOverride?: string;
    };
    res: {
      runId: string;
      /** Stable reference for what got claimed (e.g. `issue#42`, `backlog#<id>`, `plan:<id>`). */
      taskRef: string | null;
      /** Human-readable title — GitHub issue title, plan name, etc. */
      taskContext: string | null;
    };
  };
  'agents:cancel': { req: { runId: string }; res: { ok: true } };
  'bugFixer:health': {
    req: { repoId: string };
    res: BugFixerHealth;
  };
  'agents:update': { req: { agentId: string; patch: Partial<Agent> }; res: Agent };
  'agents:create': {
    req: {
      repoId: string;
      name: AgentName;
      displayName?: string;
      scheduleCron?: string | null;
      runnerOverride?: RunnerKind | null;
    };
    res: Agent;
  };
  'agents:clone': { req: { agentId: string }; res: Agent };
  'agents:delete': { req: { agentId: string }; res: { ok: true } };
  'agents:readMd': {
    req: { repoId: string; agentName: AgentName };
    res: { source: 'builtin' | 'override'; markdown: string; skills: string[] };
  };

  // Runner — non-interactive sign-in probe driving the auth banner's
  // "Verify sign-in" button. Lets the user clear a stale signed-out state
  // without triggering a real agent run.
  'runner:probeAuth': {
    req: { runner: RunnerKind };
    res: {
      runner: RunnerKind;
      status: 'signed_in' | 'signed_out' | 'cli_missing' | 'unknown';
      detail: string;
    };
  };

  // Models — dynamic discovery (CLI config + live API + curated fallback).
  // Replaces the renderer's hardcoded MODEL_OPTIONS for non-stale dropdowns.
  'models:list': {
    req: { runner: RunnerKind };
    res: {
      runner: RunnerKind;
      models: { id: string; label: string; tier: 'flagship' | 'balanced' | 'fast' | 'reasoning' }[];
      /** What the CLI will use when no override is passed (read from CLI config). */
      defaultModelId: string | null;
      source: 'live-api' | 'curated';
      fetchedAt: ISO;
    };
  };

  // Stats / history (Phase 2 detail-pane)
  'runs:stats': {
    req: { agentId: string; days?: number };
    res: {
      runs: number;
      prsOpened: number;
      issuesFiled: number;
      reviewsLeft: number;
      falsePositiveRate: number;
      avgDurationMs: number;
    };
  };
  'runs:histogram': {
    req: { agentId: string; hours?: number };
    res: {
      cells: { dayOfWeek: number; hour: number; runs: number; issues: number }[];
    };
  };

  // Runs
  'runs:list': { req: { repoId: string; limit?: number; before?: ISO }; res: Run[] };
  'runs:get': {
    req: { runId: string };
    res: Run & { auditLog: AuditLine[]; evidence: EvidenceItem[] };
  };
  'runs:delete': { req: { runId: string }; res: { ok: true } };
  'runs:deleteCompleted': {
    req: { repoId: string; states?: RunState[] };
    res: { deleted: number };
  };

  // Backlog
  'backlog:list': { req: { repoId: string }; res: BacklogItem[] };
  'backlog:reorder': { req: { repoId: string; orderedIds: string[] }; res: { ok: true } };
  'backlog:setOverride': {
    req: { itemId: string; runner?: RunnerKind | null; agent?: AgentName | null };
    res: BacklogItem;
  };
  /**
   * Force a backlog sync against GitHub for the given repo and return the
   * refreshed list. Used by the Backlog screen's "Refresh" button so the
   * user can pull immediately without waiting for the periodic sweep.
   */
  'backlog:refresh': { req: { repoId: string }; res: BacklogItem[] };

  // Playbook
  'playbook:get': { req: { repoId: string }; res: Playbook };
  'playbook:save': { req: { repoId: string; files: PlaybookFile[] }; res: { ok: true } };
  'playbook:regenerate': {
    req: { repoId: string; mode: PlaybookRegenMode };
    res: { ok: true; generatedAt: ISO; fileCount: number; framework: string };
  };

  // Observe-mode previews — the issues / playbook agents would have filed
  // if the repo's safety mode allowed writes.
  'previews:list': {
    req: { repoId: string };
    res: {
      findings: PreviewedFinding[];
      playbookDraft: {
        generatedAt: ISO;
        framework: string;
        criticalFlows: string[];
        fileCount: number;
      } | null;
    };
  };
  'previews:get': { req: { previewId: number }; res: PreviewedFinding };
  'previews:fileIssue': {
    req: { previewId: number; title: string; body: string; labels: string[] };
    res: { issueNumber: number; htmlUrl: string };
  };
  'previews:dismiss': { req: { previewId: number }; res: { ok: true } };

  // Test plans — gate the QA agent run flow.
  'testPlans:list': {
    req: { repoId: string; agentName?: AgentName };
    res: TestPlanSummary[];
  };
  'testPlans:get': { req: { planId: string; repoId: string }; res: TestPlan };
  'testPlans:save': {
    req: {
      planId: string;
      repoId: string;
      blocks: TestPlanBlock[];
      name?: string;
      agentNames?: AgentName[];
    };
    res: { savedAt: ISO };
  };
  'testPlans:generate': {
    req: {
      repoId: string;
      agentName: AgentName;
      scope: TestPlanScope;
      featureName?: string;
      /** Per-generation override; falls through to Settings when absent. */
      runnerOverride?: RunnerKind;
      /** Per-generation override; falls through to Settings when absent. Empty string clears. */
      modelOverride?: string;
      /**
       * Bias the AI toward files the Coverage screen flags as needing
       * attention (uncovered / churned since last pass / open findings).
       * No effect on the heuristic seed.
       */
      focusOnChangedOrUncovered?: boolean;
    };
    res: { jobId: string };
  };
  'testPlans:generationJobs': {
    req: { repoId?: string };
    res: TestPlanGenerationJob[];
  };
  'testPlans:dismissJob': { req: { jobId: string }; res: { ok: true } };
  'testPlans:delete': { req: { planId: string; repoId: string }; res: { ok: true } };

  // Coverage map — file × case × finding × churn report for the repo.
  'coverage:list': {
    req: { repoId: string };
    res: CoverageReport;
  };

  // iOS QA Pilot
  'qa:list': { req: { repoId: string }; res: QaFlow[] };
  'qa:plan': {
    req: { repoId: string };
    res: { enqueued: number; runIds: string[]; reason?: string };
  };
  'qa:reset': {
    req: { repoId: string; scope?: 'unverified' | 'all' };
    res: { cycle: number };
  };
  'qa:runFlow': { req: { repoId: string; flowId: string }; res: { runId: string } };
  'qa:doctor': { req: { repoId: string }; res: DoctorReport };
  'qa:doctorSetup': { req: { repoId: string }; res: DoctorReport };
  'qa:warmPool': { req: void; res: { ok: true } };
  'qa:getConfig': {
    req: { repoId: string };
    res: { appPath: string; bundleId: string; simulatorDevice: string; flowsDir: string };
  };
  'qa:saveConfig': {
    req: {
      repoId: string;
      appPath?: string;
      bundleId?: string;
      simulatorDevice?: string;
    };
    res: { appPath: string; bundleId: string; simulatorDevice: string; flowsDir: string };
  };

  // Settings
  'settings:get': { req: void; res: Settings };
  'settings:update': { req: Partial<Settings>; res: Settings };

  // Diagnostics
  'system:info': {
    req: void;
    res: { version: string; dbPath: string; userDataDir: string; node: string; electron: string };
  };
}

export type IpcChannel = keyof IpcMap;

/* ---------- Coverage report ---------- */

/**
 * Per-file coverage stats. The `caseCount` is the strongest signal — files
 * with `caseCount === 0` have never been touched by any plan and should be
 * surfaced as "dark" on the Coverage screen.
 */
export interface CoverageEntry {
  path: string;
  caseCount: number;
  findingsCount: number;
  lastPassedAt: ISO | null;
  churnSinceLastPass: number;
}

export interface CoverageReport {
  repoId: string;
  files: CoverageEntry[];
  labels: { label: string; planCount: number; caseCount: number }[];
  totalFiles: number;
  coveredFiles: number;
  uncoveredFiles: number;
  lastDoneAt: ISO | null;
}

/* ---------- Bus events ---------- */

export type BusEvent =
  | { type: 'run.created'; run: Run }
  | { type: 'run.transition'; runId: string; state: RunState; at: ISO }
  | { type: 'run.audit'; runId: string; line: AuditLine }
  | {
      type: 'run.caseProgress';
      runId: string;
      caseId: string;
      status: CaseProgressState;
    }
  | { type: 'run.deleted'; runId: string; repoId: string }
  | { type: 'backlog.changed'; repoId: string }
  | { type: 'auth.changed'; signedIn: boolean }
  | { type: 'evidence.missing'; runId: string; missing: string[] }
  | { type: 'qa.flowChanged'; repoId: string; flowId: string }
  | { type: 'qa.doctorChanged'; repoId: string }
  | {
      type: 'qa.doctorProgress';
      repoId: string;
      step: DoctorSetupStep;
      label: string;
      status: 'started' | 'completed' | 'failed';
    }
  | { type: 'previews.changed'; repoId: string }
  | { type: 'testPlans.changed'; repoId: string }
  | { type: 'testPlanGeneration.progress'; job: TestPlanGenerationJob }
  | {
      type: 'agent.autoPaused';
      repoId: string;
      agentId: string;
      agentName: AgentName;
      displayName: string;
      reason: 'consecutive_failures';
      consecutiveFailures: number;
      lastErrorCode: string | null;
      lastErrorSummary: string | null;
    }
  | { type: 'system.heartbeat'; at: ISO };

/* ---------- Renderer-side bridge surface ---------- */

export interface ObeliskBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcMap[C]['req'],
  ): Promise<import('./errors').Result<IpcMap[C]['res']>>;
  subscribe(handler: (event: BusEvent) => void): () => void;
}

declare global {
  interface Window {
    obelisk: ObeliskBridge;
  }
}
