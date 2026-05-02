/**
 * Cross-process types. Source of truth: docs/TECH_DESIGN.md §3.
 * Adding a new IPC channel: declare it in IpcChannels (this file), register
 * a handler in src/main/ipc/register.ts, and bump the closed enum in
 * src/shared/errors.ts if a new error code is needed.
 */

export type SafetyMode = 'observe' | 'issues' | 'prs' | 'automerge';
export type RunnerKind = 'claude' | 'codex';
export type RunState = 'queued' | 'running' | 'publishing' | 'done' | 'failed' | 'paused';
export type AgentName = 'qa-hunter' | 'manual-qa' | 'bug-fixer' | 'feature-builder' | 'pr-reviewer';
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

export interface Agent {
  id: string;
  repoId: string;
  name: AgentName;
  enabled: boolean;
  runnerOverride: RunnerKind | null;
  scheduleCron: string | null;
  timeoutMs: number;
}

export interface Run {
  id: string;
  repoId: string;
  agentName: AgentName;
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
}

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
  'auth:setRunnerKey': { req: { runner: RunnerKind; key: string }; res: { ok: true } };
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
    req: { repoId: string; agentName: AgentName; taskId?: string };
    res: { runId: string };
  };
  'agents:cancel': { req: { runId: string }; res: { ok: true } };
  'agents:update': { req: { agentId: string; patch: Partial<Agent> }; res: Agent };

  // Runs
  'runs:list': { req: { repoId: string; limit?: number; before?: ISO }; res: Run[] };
  'runs:get': {
    req: { runId: string };
    res: Run & { auditLog: AuditLine[]; evidence: EvidenceItem[] };
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
  | { type: 'backlog.changed'; repoId: string }
  | { type: 'auth.changed'; signedIn: boolean }
  | { type: 'evidence.missing'; runId: string; missing: string[] }
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
