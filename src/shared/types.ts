/**
 * Cross-process types. Source of truth: docs/TECH_DESIGN.md §3.
 * Adding a new IPC channel: declare it in IpcChannels (this file), register
 * a handler in src/main/ipc/register.ts, and bump the closed enum in
 * src/shared/errors.ts if a new error code is needed.
 */

export type SafetyMode = 'observe' | 'issues' | 'prs' | 'automerge';
export type RunnerKind = 'claude' | 'codex';
export type RunState = 'queued' | 'running' | 'publishing' | 'done' | 'failed' | 'paused';
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
  runnerUsed: RunnerKind;
  fallbackUsed: boolean;
  outputSummary: string | null;
  errorCode: string | null;
}

export interface AuditLine {
  id: number;
  runId: string;
  at: ISO;
  kind: string;
  payload: unknown;
}

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

export interface Settings {
  defaultRunner: RunnerKind;
  attributionMode: AttributionMode;
  cloudExecutionEnabled: boolean; // v0.1: always false
}

export interface EvidenceItem {
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
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
    req: { agentId: string; taskId?: string };
    res: { runId: string };
  };
  'agents:cancel': { req: { runId: string }; res: { ok: true } };
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
      findings: {
        id: number;
        runId: string;
        agentName: AgentName;
        at: ISO;
        title: string;
        body: string;
        labels: string[];
      }[];
      playbookDraft: {
        generatedAt: ISO;
        framework: string;
        criticalFlows: string[];
        fileCount: number;
      } | null;
    };
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

/* ---------- Bus events ---------- */

export type BusEvent =
  | { type: 'run.created'; run: Run }
  | { type: 'run.transition'; runId: string; state: RunState; at: ISO }
  | { type: 'run.audit'; runId: string; line: AuditLine }
  | { type: 'run.deleted'; runId: string; repoId: string }
  | { type: 'backlog.changed'; repoId: string }
  | { type: 'auth.changed'; signedIn: boolean }
  | { type: 'evidence.missing'; runId: string; missing: string[] }
  | { type: 'qa.flowChanged'; repoId: string; flowId: string }
  | { type: 'qa.doctorChanged'; repoId: string }
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
