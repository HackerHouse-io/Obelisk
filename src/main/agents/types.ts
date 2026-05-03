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
}

export interface SelectTaskInput {
  repo: Repo;
  /** The default runner for this repo. */
  defaultRunner: RunnerKind;
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
  | { kind: 'pr'; title: string; body: string; head: string; base: string; draft: true }
  | { kind: 'issue'; title: string; body: string; labels: string[] }
  | { kind: 'comment'; issueNumber: number; body: string }
  | {
      kind: 'review';
      prNumber: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
    }
  | { kind: 'noop'; reason: string };
