import type { RunnerKind } from '../../shared/types';
import type { CompiledPrompt } from '../prompt-compiler';

export interface AuditLine {
  /** Wall-clock ISO. */
  at: string;
  /** Free-form kind: 'stdout' | 'stderr' | 'state' | 'tool_call' | etc. */
  kind: string;
  /** Anything JSON-serializable. */
  payload: unknown;
}

export interface RunOpts {
  /** Working directory: a per-run git worktree. */
  worktreePath: string;
  prompt: CompiledPrompt;
  timeoutMs: number;
  /** Stream stdout / stderr / lifecycle events to the audit log. */
  onAudit: (line: AuditLine) => void;
  /**
   * Commit the worktree was at BEFORE the runner ran (a full SHA captured
   * by the orchestrator right after worktree setup). Bug Fixer's Prove-It
   * pattern tells the agent to land its work as separate commits (failing
   * test, then fix), so a clean working tree with HEAD ahead of `baseRef`
   * is the normal happy path — `collectPatch` uses `baseRef..HEAD` to
   * materialize the patch when nothing is left staged. Optional only so
   * MockRunner / unit fixtures don't have to thread it through.
   */
  baseRef?: string;
}

export interface GitPatch {
  /** unified-diff text — all changes the runner staged. */
  diff: string;
  /** Files the runner touched (write, create, delete). Sorted, distinct. */
  filesChanged: string[];
}

export interface TestRun {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Last ~200 lines of output. The full log lives in evidence_artifacts. */
  summary: string;
}

export type RunResult =
  | { ok: true; patch: GitPatch; testsRun: TestRun[]; reasoning: string }
  | {
      ok: false;
      reason: 'timeout' | 'crash' | 'non_zero_exit' | 'no_changes' | 'auth_required';
      detail: string;
      /**
       * Captured stdout. Only meaningful for `no_changes` (read-only agents
       * report this as their normal success path; their entire output is on
       * stdout and we MUST not lose it — that's where BEGIN_FINDINGS lives).
       * Other failure reasons may set this best-effort.
       */
      reasoning?: string;
    };

export interface CodingAgentRunner {
  readonly kind: RunnerKind;
  isInstalled(): Promise<{ ok: boolean; version?: string; hint?: string }>;
  run(opts: RunOpts, abort: AbortSignal): Promise<RunResult>;
}
