/**
 * Task ref parsers shared between main + renderer. Task refs are short
 * identifiers carried on a Run row that encode "what is this run
 * working on" — e.g. `plan:full-app`, `gh:42`, `ios-qa:<flow>:<run>:plan:<id>`.
 *
 * Centralizing here so the orchestrator's encoders + Mission Control's
 * decoders stay in lockstep across releases.
 */

export interface ParsedIosQaTaskRef {
  flowId: string;
  tempRunId: string;
  /** Plan id is optional for backward compatibility with old refs. */
  planId: string | null;
}

/**
 * Decode the iOS QA Pilot task ref:
 *   ios-qa:<flow_id>:<temp_run_id>[:plan:<plan_id>]
 *
 * Returns null when the ref doesn't have the iOS QA prefix. Flow ids
 * and temp run ids are ULIDs (no colons), so segment matching with
 * `[^:]+` is unambiguous.
 */
export function parseIosQaTaskRef(ref: string | null): ParsedIosQaTaskRef | null {
  if (!ref) return null;
  const match = /^ios-qa:([^:]+):([^:]+)(?::plan:([^:\s]+))?$/.exec(ref);
  if (!match) return null;
  return {
    flowId: match[1]!,
    tempRunId: match[2]!,
    planId: match[3] ?? null,
  };
}

/**
 * Build an iOS QA Pilot task ref. The `planId` is optional because
 * older callers (and a brief window of agent runs) didn't embed it;
 * once it's present, Mission Control surfaces the per-case plan tab.
 */
export function buildIosQaTaskRef(opts: {
  flowId: string;
  tempRunId: string;
  planId?: string | null;
}): string {
  const base = `ios-qa:${opts.flowId}:${opts.tempRunId}`;
  return opts.planId ? `${base}:plan:${opts.planId}` : base;
}

/**
 * Extract the plan id from any task ref shape that carries one:
 *   - `plan:<id>` (QA Hunter, Manual QA)
 *   - `ios-qa:<flow>:<run>:plan:<id>` (iOS QA Pilot)
 *
 * Returns null for refs that don't reference a plan (e.g. `gh:42`,
 * `backlog:item-9`, or older iOS refs without the plan segment).
 */
export function parsePlanIdFromTaskRef(taskRef: string | null): string | null {
  if (!taskRef) return null;
  if (taskRef.startsWith('plan:')) return taskRef.slice('plan:'.length);
  const ios = parseIosQaTaskRef(taskRef);
  return ios?.planId ?? null;
}

/**
 * Decode a backlog task ref produced by Bug Fixer / Feature Builder:
 *   - `issue#<n>`      — a GitHub issue
 *   - `backlog#<ulid>` — a manual backlog item
 *
 * Returns null for any other shape. Used by the retry path to re-target the
 * exact backlog item a failed run was working on.
 */
export type ParsedBacklogTaskRef =
  | { kind: 'issue'; issueNumber: number }
  | { kind: 'backlog'; id: string };

export function parseBacklogTaskRef(ref: string | null): ParsedBacklogTaskRef | null {
  if (!ref) return null;
  const issue = /^issue#(\d+)$/.exec(ref);
  if (issue) return { kind: 'issue', issueNumber: Number(issue[1]) };
  const backlog = /^backlog#(.+)$/.exec(ref);
  if (backlog) return { kind: 'backlog', id: backlog[1]! };
  return null;
}

/**
 * Decode the PR Reviewer task ref: `pr#<n>@<short_sha>`. Returns null for
 * other shapes. Used by the retry path to re-review a specific PR.
 */
export interface ParsedPrTaskRef {
  prNumber: number;
  shortSha: string;
}

export function parsePrTaskRef(ref: string | null): ParsedPrTaskRef | null {
  if (!ref) return null;
  const match = /^pr#(\d+)@([0-9a-f]+)$/i.exec(ref);
  if (!match) return null;
  return { prNumber: Number(match[1]), shortSha: match[2]! };
}
