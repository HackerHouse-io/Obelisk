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
   * When true, a *failed* Evidence Pack check does NOT pause the run. Instead
   * the gap is labeled in the PR body (with a transparency note), the agent's
   * manual verification is surfaced, and the PR ships anyway — the
   * self-verifying PR Reviewer is the real downstream check.
   *
   * Patch-producing agents (Bug Fixer, Feature Builder) set this. A headless
   * coding-agent CLI running in a worktree often cannot capture a UI
   * screenshot, and a permanently-paused run (EVIDENCE_INCOMPLETE) is strictly
   * worse than a shipped-and-labeled one. The agents instead climb a proof
   * ladder — Playwright screenshot → UI test → manual verification note (see
   * `agents/bug-fixer.md`); this flag is the floor that guarantees the run
   * never gets stuck on evidence it could not produce.
   */
  readonly softEvidenceGate?: boolean;

  /**
   * Register run-local evidence artifacts (screenshots, UI-test output, backend
   * logs) BEFORE the Evidence Pack gate runs, and report which tier of proof
   * the agent achieved. The orchestrator calls this right before
   * `checkEvidence`, so Tier-1/2 evidence actually counts toward the gate
   * (registering it later — e.g. in `interpretResult` — is too late, the gate
   * has already run). Side-effects via saveArtifact / registerArtifactFromPath;
   * the returned hints thread into both the gate and the PR-body renderer.
   */
  collectEvidence?(input: CollectEvidenceInput): CollectedEvidence | Promise<CollectedEvidence>;

  /**
   * Whether the runner is expected to produce a patch in the worktree.
   * Read-only agents (QA Hunter, Manual QA) set this to false:
   * the orchestrator then treats `RunResult.reason === 'no_changes'` as a
   * successful run and skips the patch/failing-test-diff artifacts.
   */
  readonly producesPatch: boolean;

  /**
   * Whether a run of this agent must be paired with a test plan (QA Hunter,
   * Manual QA, iOS QA Pilot). When true, both the scheduler and the manual
   * dispatch resolve a concrete plan before spawning: the agent's
   * `defaultPlanId` if set, otherwise the plan whose feature has the lowest
   * coverage (worst-first). Without this, a scheduled run with no hint and
   * multiple plans throws TEST_PLAN_REQUIRED before a run row exists, leaving
   * the schedule stuck at "Next now".
   */
  readonly requiresTestPlan?: boolean;

  /**
   * Findings always go to the previews table for human approval, regardless
   * of repo safety mode. The user must click "Open on GitHub" in the
   * FileIssueModal to actually file. QA Hunter and Manual QA opt in — a
   * false-positive QA run shouldn't be able to pollute the user's GitHub
   * just because the repo is in `issues+` / `prs+` / `automerge` mode.
   *
   * The orchestrator's preview-vs-publish gate honors this flag in
   * preference to the older `skipsEvidenceGate && observe` rule. The
   * `previews:fileIssue` IPC remains the user-approved bypass that calls
   * `publish({ ..., manual: true })`.
   */
  readonly alwaysPreview?: boolean;

  /**
   * Whether the runner *may* produce a patch but `no_changes` is still a
   * successful run as long as structured stdout was emitted. Used by PR
   * Reviewer in fix mode: the worktree is attached to the PR's branch so
   * the runner CAN commit fixes — but it's also fine to emit a clean
   * review with zero file edits. The orchestrator's `no_changes`
   * coercion treats both producesPatch=false and optionalPatch=true as
   * acceptable for an empty diff (the latter additionally requires a
   * structured-output marker to guard against silent runner crashes).
   */
  readonly optionalPatch?: boolean;

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
   * Retry override. When set alongside an explicit `taskId`, the handler
   * should re-target that exact task and bypass its dedup/caps (e.g.
   * pr-reviewer's already-reviewed / failed-attempt cap, bug-fixer's stale
   * filters). Atomic claims still apply, so two concurrent retries can't
   * both win. Set by the manual Retry button and the infra auto-retry path.
   */
  forceTask?: boolean;
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
   * Set by handlers that want the orchestrator to (a) attach the worktree
   * to an existing branch instead of forking a fresh one off the default
   * branch, and (b) push fix-up commits to an already-open PR (skipping
   * `pulls.create`). PR Reviewer sets this in fix mode for Obelisk-opened
   * PRs so the runner can commit on top of the PR's head and the publisher
   * appends to the existing PR. Mirrors the worktree behavior of
   * `RunAgentInput.resumeContext` without coupling to that mechanism.
   */
  attachToBranch?: { branch: string; existingPrNumber: number };
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

export interface CollectEvidenceInput {
  repo: Repo;
  runId: string;
  /**
   * Absolute path of the worktree the agent ran in — where it wrote any
   * screenshots / logs / test output. Artifact paths in the agent's structured
   * report are resolved relative to this, NOT `repo.localPath`.
   */
  worktreePath: string;
  runResult: Extract<RunResult, { ok: true }>;
}

/**
 * Hints returned by `collectEvidence`, threaded into the Evidence Pack gate and
 * the PR-body renderer. Models the proof ladder: which tier of UI verification
 * the agent achieved this run, plus the artifacts that back it.
 */
export interface CollectedEvidence {
  /**
   * The agent's self-declared UI proof tier. `'ui_test'` satisfies the
   * `ui_screenshot_if_ui_touched` requirement in lieu of an actual screenshot
   * (the headless runner couldn't capture one); `'manual'` is the soft floor.
   */
  uiVerification?: 'screenshot' | 'ui_test' | 'manual';
  /** Relative path (within the patch) of the UI/e2e test that proves the fix. */
  uiTestFile?: string;
  /** The agent's manual-verification note — surfaced in the PR body. */
  manualVerification?: string;
}

export type PublishPlan =
  | { kind: 'pr'; title: string; body: string; head: string; base: string }
  | {
      kind: 'issue';
      title: string;
      body: string;
      labels: string[];
      /**
       * Optional sha256 of the normalized content (title + expected + actual
       * + sorted suspected files). Lets the dedup pool drop a re-emitted
       * finding by exact content match even when the agent reworded the
       * title between runs. QA agents compute this; persisted on the
       * preview row (column added in migration 010). Older rows that
       * predate the migration keep fingerprint = NULL and fall back to
       * title-similarity dedup.
       */
      fingerprint?: string;
      /**
       * Structured form of the finding, when the agent emitted one (QA
       * Hunter, Manual QA). Persisted on the preview row so the FileIssue
       * follow-up refiner can re-emit the same `bodyFor` rendering after
       * the user chats with the agent to reframe the issue.
       */
      finding?: import('../../shared/types').QaFinding;
    }
  | { kind: 'comment'; issueNumber: number; body: string }
  | {
      kind: 'review';
      prNumber: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
    }
  | { kind: 'noop'; reason: string };
