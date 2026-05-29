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
  /**
   * Soft-delete marker for the Archive feature. `null` for live runs visible
   * in Mission Control; an ISO timestamp once the user has moved the run to
   * the archive via "Archive completed" or a per-card archive action. Hard
   * delete clears the row entirely; restoring sets this back to null.
   */
  archivedAt: ISO | null;
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
   * - `case_progress_orphan` — same payload shape as `case_progress` but the
   *   `caseId` wasn't in the run's assigned plan. Recorded for diagnostics so
   *   prompt-drift (agent echoing the wrong id) is visible to the user as a
   *   footnote without inflating plan counts.
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

export type CoverageMapGenerationStage =
  | 'queued'
  | 'spawning'
  | 'reading'
  | 'writing'
  | 'done'
  | 'failed';

export interface CoverageMapGenerationJob {
  jobId: string;
  repoId: string;
  stage: CoverageMapGenerationStage;
  status: string;
  startedAt: ISO;
  finishedAt: ISO | null;
  /** Number of labels in the final map when stage='done'. */
  labelCount: number | null;
  /** Labels added relative to the previous map (stage='done'). */
  addedLabels: string[] | null;
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
  /**
   * What happens when the user clicks Delete on a Mission Control run card.
   * 'ask' (default) — prompt with Archive / Delete-permanently radios.
   * 'archive' — silently move to the Archive.
   * 'delete'  — silently hard-delete (with cascade).
   * The dialog itself sets this when the user ticks "always do this".
   */
  cardRemoveAction: 'ask' | 'archive' | 'delete';
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
  /**
   * Structured form of the finding, when available. Captured by QA-Hunter
   * on emit and persisted on the preview row so the follow-up refiner can
   * regenerate `body` deterministically via the same `bodyFor` template.
   * Older previews predate this field and have it omitted; refine is
   * disabled for those rows.
   */
  finding: QaFinding | null;
}

/**
 * Structured QA finding as parsed from the agent's `BEGIN_FINDINGS` block.
 * Lives in shared so both the QA-Hunter handler and the renderer's
 * follow-up panel can reference the same shape.
 */
export interface QaFinding {
  title: string;
  severity: FindingSeverity;
  description: string;
  expected: string;
  actual: string;
  repro: string;
  evidence?: string;
  suspected_files: string[];
  suggested_test: string;
  suspected_kind?: 'bug' | 'coverage';
  case_id?: string;
  /**
   * Labels carried with the finding. QA-Hunter populates from severity +
   * obelisk:fix; the refiner may add/remove (e.g. add "spec" when the
   * user reframes a bug as a spec fix).
   */
  labels?: string[];
}

/** Visible follow-up message in the FileIssueModal refine panel. */
export type PreviewFollowupRole = 'user' | 'assistant' | 'system';
export interface PreviewFollowup {
  id: number;
  previewId: number;
  role: PreviewFollowupRole;
  content: string;
  createdAt: ISO;
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

  // Filesystem (read-only directory listing for the branded folder picker)
  'fs:listDir': {
    req: { path?: string; showHidden?: boolean };
    res: {
      path: string;
      parent: string | null;
      entries: { name: string; isDir: boolean; isHidden: boolean }[];
    };
  };

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
       * - non-empty string → that exact model id (e.g. "claude-opus-4-7")
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

  // Runners — quick installed-state check for both CLIs at once. Drives the
  // pre-flight disable on the per-feature Generate button so we don't dispatch
  // a generation job that's guaranteed to fail.
  'runners:installed': {
    req: Record<string, never>;
    res: {
      claude: { installed: boolean; version?: string; hint?: string };
      codex: { installed: boolean; version?: string; hint?: string };
    };
  };

  // Models — dynamic discovery, CLI-sourced (no API key). Claude rows are the
  // always-latest aliases (opus/sonnet/haiku) labelled with the concrete
  // version the CLI resolves via its init handshake. See model-discovery.ts.
  'models:list': {
    req: {
      runner: RunnerKind;
      /** Force a fresh CLI init-probe (the dropdown's refresh button). */
      refresh?: boolean;
    };
    res: {
      runner: RunnerKind;
      models: { id: string; label: string; tier: 'flagship' | 'balanced' | 'fast' | 'reasoning' }[];
      /** What the CLI will use when no override is passed (read from CLI config). */
      defaultModelId: string | null;
      source: 'cli-probe' | 'observed' | 'fallback';
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
  /**
   * Live runs (queued / running / publishing / paused) for a repo. Drives
   * the per-feature-card "Running…" state so the renderer reflects in-flight
   * work even when the originating click happened in another window or
   * before mount.
   */
  'runs:activeForRepo': {
    req: { repoId: string };
    res: { runId: string; agentName: AgentName; taskRef: string | null; state: RunState }[];
  };
  'runs:get': {
    req: { runId: string };
    res: Run & { auditLog: AuditLine[]; evidence: EvidenceItem[] };
  };
  'runs:delete': { req: { runId: string }; res: { ok: true } };
  'runs:deleteCompleted': {
    req: { repoId: string; states?: RunState[] };
    res: { deleted: number };
  };
  /** Soft-delete a single run by setting archived_at. */
  'runs:archive': { req: { runId: string }; res: { ok: true } };
  /**
   * Soft-delete every completed (done/failed by default) run for a repo.
   * `total` is the post-archive count of archived rows so the caller can
   * refresh its toolbar pill without a follow-up `archive:count`.
   */
  'runs:archiveCompleted': {
    req: { repoId: string; states?: RunState[] };
    res: { archived: number; total: number };
  };
  /** List archived runs for a repo, optionally filtered by a free-text query. */
  'archive:list': {
    req: { repoId: string; query?: string; limit?: number };
    res: Run[];
  };
  /** Cheap count of archived rows for the Mission Control toolbar pill. */
  'archive:count': { req: { repoId: string }; res: { count: number } };
  /** Clear archived_at and return the run to Mission Control. */
  'archive:restore': { req: { runId: string }; res: { ok: true } };
  /** Permanently delete every archived run for a repo. */
  'archive:deleteAll': { req: { repoId: string }; res: { deleted: number } };

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
  'previews:undismiss': { req: { previewId: number }; res: { ok: true } };
  /**
   * Pre-flight probe: is the connected coding-agent CLI installed and
   * signed in? Drives whether the Follow-up panel's Send button is
   * enabled. Cached for ~60s in the main process to keep modal opens
   * snappy.
   */
  'previews:refineAvailable': {
    req: { previewId: number };
    res:
      | { ok: true; runner: RunnerKind }
      | { ok: false; runner: RunnerKind; reason: 'cli_missing' | 'signed_out' | 'unknown' };
  };
  /**
   * Run one refine turn. The renderer sends the current form draft
   * (title + labels — the body is regenerated server-side by `bodyFor`
   * from the structured finding) along with the new user message so the
   * user's manual edits aren't clobbered by stale DB state. On success
   * the preview row's payload + fingerprint are overwritten and the new
   * PreviewedFinding is returned for the modal to apply.
   */
  'previews:refine': {
    req: {
      previewId: number;
      currentDraft: { title: string; labels: string[] };
      userMessage: string;
    };
    res: { assistantReply: string; updated: PreviewedFinding };
  };
  'previews:listFollowups': {
    req: { previewId: number };
    res: { messages: PreviewFollowup[] };
  };
  /**
   * Wipe the transcript and restore the original `previews.payload`
   * snapshotted on the first refine. No-op if no refine has happened.
   */
  'previews:revertFollowups': {
    req: { previewId: number };
    res: { ok: true; restored: PreviewedFinding | null };
  };
  /**
   * Synthesize a preview row from a failed plan case when the QA agent
   * emitted CASE_FAIL but did not produce a finding. Returns the new
   * preview so the renderer can hand it straight to FileIssueModal —
   * the existing `previews:fileIssue` flow then publishes it like any
   * other preview. Manual drafts are saved with `fingerprint: null`
   * so they don't dedupe against future agent findings.
   */
  'previews:createDraftFromCase': {
    req: {
      runId: string;
      caseId: string;
      caseTitle: string;
      expected: string | null;
      repro: string | null;
      severity: FindingSeverity | null;
      failureDetail: string | null;
    };
    res: PreviewedFinding;
  };
  // Foreground sync against GitHub for the Command Center "Task previews"
  // card. Drives the refresh button: triggers the same sweep that runs every
  // ~2 min in the background (additive backlog upserts + closed-issue reaper
  // + preview close-detection) and returns the refreshed previews list in
  // one round-trip.
  'previews:refresh': {
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
      /**
       * Override the plan's feature binding. Sending a non-empty string pins
       * this plan to that feature label (and flips scope to 'feature'); sending
       * null unpins it (and flips scope back to 'whole-app'). Omit to leave
       * the existing binding untouched.
       */
      feature?: string | null;
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
  // Bootstrap `qa/coverage-map.md` from a heuristic + filesystem scan.
  // - `commit: false / omitted` → return proposed entries for preview only.
  // - `commit: true`            → write the file (refuses to overwrite a
  //                                user-edited map unless `force: true`).
  // - `force: true`             → MERGE: write the union of existing labels
  //                                and newly-detected scanner labels.
  'coverage:bootstrapMap': {
    req: { repoId: string; commit?: boolean; force?: boolean };
    res: {
      proposals: { label: string; globs: string[]; filesMatched: number }[];
      written: boolean;
      reason?: string;
    };
  };
  // LLM-driven feature analysis. Spawns Claude / Codex CLI to read the
  // entire codebase (the same pattern test plan generation uses) and
  // produce a comprehensive list of features. Returns immediately with a
  // jobId; the actual work runs in the background and reports progress via
  // the `coverageMapGeneration.progress` bus event.
  'coverage:generateMap': {
    req: {
      repoId: string;
      runnerOverride?: RunnerKind;
      modelOverride?: string;
      /**
       * When true (default), the LLM's proposed features REPLACE the existing
       * map. When false, they MERGE — used by the "Keep existing labels"
       * checkbox in the regenerate dialog. Default exists to break the
       * previous merge-only accumulation bug.
       */
      replace?: boolean;
    };
    res: { jobId: string };
  };
  /**
   * Remove labels from qa/coverage-map.md that match zero tracked files (or
   * the explicit `labels` list when provided). Used by the "Remove N broken
   * labels" diagnostic button to one-shot clean up bloated maps.
   */
  'coverage:cleanStaleLabels': {
    req: { repoId: string; labels?: string[] };
    res: { removed: string[] };
  };
  'coverage:generationJobs': {
    req: { repoId?: string };
    res: CoverageMapGenerationJob[];
  };
  'coverage:dismissJob': { req: { jobId: string }; res: { ok: true } };

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

/**
 * Per-feature aggregate. One per coverage-map label (or one per ad-hoc
 * label referenced by a test case but missing from the map — those land
 * in `staleLabels` instead when they match zero files).
 *
 * `coveragePct` is the composite 0..100 score driving the radar chart;
 * the formula is the same one the renderer uses to render the breakdown
 * tooltip and lives in `src/renderer/screens/coverage/coverageFormula.ts`.
 */
export interface TestPlanRef {
  id: string;
  name: string;
  agentNames: AgentName[];
  updatedAt: ISO;
}

export interface CoverageFeature {
  label: string;
  planCount: number;
  caseCount: number;
  casesPassed: number;
  filesInGlob: number;
  filesWithCases: number;
  filesRecentPass: number;
  openFindings: number;
  coveragePct: number;
  /**
   * Plans explicitly scoped to this feature (frontmatter.scope === 'feature'
   * AND frontmatter.feature === <label>). Whole-app sweeps live on
   * CoverageReport.wholeAppPlans instead.
   */
  planRefs: TestPlanRef[];
  /** Files in this label's glob — capped so the IPC payload stays bounded. */
  files: string[];
}

export interface CoverageReport {
  repoId: string;
  files: CoverageEntry[];
  /** Per-feature aggregates used by the radar + feature-card UI. */
  features: CoverageFeature[];
  /** Plans with scope === 'whole-app' — surfaced in a dedicated row in the UI. */
  wholeAppPlans: TestPlanRef[];
  /** Labels referenced by test cases but matching zero tracked files. */
  staleLabels: string[];
  /** False when `qa/coverage-map.md` is missing or empty — drives the bootstrap CTA. */
  hasCoverageMap: boolean;
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
  | { type: 'run.archived'; runId: string; repoId: string }
  | { type: 'run.restored'; runId: string; repoId: string; run: Run }
  | { type: 'archive.bulkChanged'; repoId: string; runIds: string[] }
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
  | { type: 'previews.followupChanged'; previewId: number; repoId: string }
  | { type: 'testPlans.changed'; repoId: string }
  | { type: 'testPlanGeneration.progress'; job: TestPlanGenerationJob }
  | { type: 'coverageMapGeneration.progress'; job: CoverageMapGenerationJob }
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
