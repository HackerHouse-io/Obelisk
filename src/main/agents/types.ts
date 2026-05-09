import type { AgentName, RunnerKind, Repo, BacklogItem } from '../../shared/types';
import type { TaskPayload } from '../prompt-compiler';
import type { RunResult } from '../runners/types';

/**
 * What an agent contributes beyond its `agents/<name>.md` definition file.
 * Two responsibilities:
 *   - selectTask: given a connected repo, what (if anything) should I work on next?
 *   - interpretResult: given a successful runner result, what GitHub artifacts should be published?
 */
export interface AgentHandler {
  readonly name: AgentName;

  /**
   * Whether the user can run multiple instances of this type in the same repo.
   *
   * Multi-instance agents must implement an atomic claim primitive in their
   * `selectTask` so two parallel instances pick *different* units of work
   * (different backlog items, different PRs, different flows).
   *
   * Singletons (qa-hunter, manual-qa today) sweep the whole repo per run and
   * have no natural way to partition work; the renderer disables "+ Add
   * another" for these and the IPC rejects creation with `AGENT_SINGLETON`.
   */
  readonly multiInstance: boolean;

  /**
   * Short blurb shown in the AddAgentPicker explaining what a 2nd instance
   * does. The user reads this to decide if more parallelism is worth it.
   */
  readonly addAnotherExplainer: string;

  /**
   * Pick the next task this agent should work on, or null if there's nothing
   * (queued items in flight don't count). Implementations MUST run the
   * actor-allowlist gate on any GitHub-derived task before returning it.
   */
  selectTask(input: SelectTaskInput): Promise<SelectedTask | null>;

  /**
   * Convert a successful RunResult into one or more publish plans. Called
   * only after the Evidence Pack check has passed (or skipped, when the
   * agent doesn't open PRs).
   *
   * Most agents return exactly one plan. QA Hunter and Manual QA return
   * many — one per finding. Returning [] is allowed and means "nothing
   * actionable was produced this run."
   */
  interpretResult(
    input: InterpretResultInput,
  ): Promise<PublishPlan | PublishPlan[]> | PublishPlan | PublishPlan[];

  /**
   * Whether this agent's output skips the Evidence Pack gate. Issue-filing
   * agents (QA Hunter, Manual QA) don't write code, so the gate doesn't
   * apply. PR-opening agents (Bug Fixer, Feature Builder) MUST go through
   * the gate.
   */
  readonly skipsEvidenceGate: boolean;

  /**
   * Whether the runner is expected to produce a patch in the worktree.
   * Read-only agents (QA Hunter, Manual QA, PR Reviewer) set this to false:
   * the orchestrator then treats `RunResult.reason === 'no_changes'` as a
   * successful run and skips the patch/failing-test-diff artifacts.
   */
  readonly producesPatch: boolean;

  /**
   * Side-effecting setup the orchestrator runs after `selectTask` succeeds
   * but BEFORE the runner is spawned. Use this for infrastructure that
   * must exist for the agent to function — booting a simulator, spawning
   * an Appium server, warming a database. Returning a `RunInfra` lets
   * the orchestrator call `teardown()` after the run terminates (success
   * or failure), which is guaranteed to run even if the spawn crashes.
   *
   * If `preRun` throws, the run transitions to failed and `postRun`
   * is not invoked.
   */
  preRun?(input: PreRunInput): Promise<RunInfra | null>;
}

export interface PreRunInput {
  runId: string;
  selected: SelectedTask;
  repo: Repo;
}

export interface RunInfra {
  /**
   * Always runs in the orchestrator's `finally` block. Errors are
   * swallowed — they should not shadow run failure. Make this idempotent.
   */
  teardown: () => Promise<void>;
}

export interface SelectTaskInput {
  repo: Repo;
  /** The default runner for this repo. */
  defaultRunner: RunnerKind;
  /**
   * What kicked off this run — `manual` means a user explicitly clicked
   * Run now, `schedule` is cron, `webhook` / `cloud` are remote triggers.
   * The bug-fixer uses this to decide whether to (a) run an inline
   * backlog sync when the local table is empty, and (b) bypass the
   * actor allowlist (manual = the user is vouching for the action).
   */
  trigger: 'schedule' | 'manual' | 'webhook' | 'cloud';
  /**
   * Optional hint passed through from `agents:run`'s `taskId`. Agents can
   * use this to bias their task selection — e.g. iOS QA Pilot interprets
   * `flow:<flow_id>` to claim a specific flow. Unrecognised hints are
   * ignored.
   */
  taskId?: string;
  /**
   * Calling instance's id, when available. Multi-instance handlers attach
   * this to their atomic claim rows (e.g. pr_review_claims.agent_id).
   * Optional so legacy / test callers don't have to provide it.
   */
  agentId?: string;
}

/**
 * Marker passed through `RunAgentInput` for resumed runs (e.g. the
 * CI-failure auto-fix loop). When set, the orchestrator bypasses the
 * agent's `selectTask` and assembles the SelectedTask itself: the worktree
 * is attached to `prBranch` (not forked from the default branch), the
 * publisher skips `gh.pulls.create` (the PR already exists), and the
 * task.context is augmented with the failure log.
 *
 * Agents don't need to inspect this — the orchestrator handles it.
 */
export interface ResumeContext {
  kind: 'ci_failure';
  prNumber: number;
  /** The PR's head ref. The orchestrator attaches a worktree to it directly. */
  prBranch: string;
  /** Original run id whose PR this is. Used for audit linkage and task_ref reuse. */
  originalRunId: string;
  /** Original task_ref so per-task-ref single-flight applies. */
  taskRef: string;
  /** Agent name to spawn for the retry — typically the same as the original run. */
  agentName: AgentName;
  /** Original GitHub issue number, if any (for sourceIssueNumber on publish). */
  githubNumber?: number;
  /**
   * Truncated failing-CI log, capped at ~10KB total. Spliced into the
   * agent's task.context so the runner can read it without an extra
   * GitHub API call.
   */
  failureLog: string;
  /** Free-form one-liner summarising the original task. Goes into task.context. */
  originalTitle: string;
}

export interface SelectedTask {
  task: TaskPayload;
  /** The backlog row to lock as in-progress, if applicable. */
  backlogItem?: BacklogItem;
  /**
   * Per-task runner override (e.g. backlog row says "force this issue to use
   * Codex"). Falls through to agent.runnerOverride / repo.defaultRunner if null.
   */
  runnerOverride?: RunnerKind | null;
  /**
   * If the agent acquired a pr_review_claims row at selectTask time, this is
   * the claim id. The orchestrator (a) attaches the run id once createRun
   * succeeds, and (b) releases the claim with a result on completion.
   */
  prReviewClaimId?: string;
  /**
   * iOS QA Pilot sets this with the simulator slot it claimed. The
   * orchestrator's preRun reads it to boot the sim and start Appium
   * before the agent spawn.
   */
  iosSimSlot?: { udid: string; appiumPort: number; wdaPort: number };
}

export interface InterpretResultInput {
  repo: Repo;
  task: TaskPayload;
  runResult: Extract<RunResult, { ok: true }>;
  /**
   * Run id, so handlers that want to persist their own evidence artifacts
   * (Manual QA's Playwright trace + screenshot) can register them via
   * `recordArtifact` and have the run's `evidence_artifacts` rows wired up.
   */
  runId: string;
}

export type PublishPlan =
  | { kind: 'pr'; title: string; body: string; head: string; base: string }
  | { kind: 'issue'; title: string; body: string; labels: string[] }
  | { kind: 'comment'; issueNumber: number; body: string }
  | {
      kind: 'review';
      prNumber: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
    }
  | { kind: 'noop'; reason: string };
