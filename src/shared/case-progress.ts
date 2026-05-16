import type { AuditLine, CaseProgressState, PreviewedFinding, RunState, TestPlan } from './types';

/**
 * Extract a case id from a finding body. Matches both the historical
 * `case_id: <id>` free-text form and the `<!-- obelisk:case_id=<id> -->`
 * HTML comment that `qa-hunter`'s `bodyFor` emits.
 */
export function caseIdFromBody(body: string): string | null {
  const m = /case[_-]?id\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i.exec(body);
  return m && m[1] ? m[1] : null;
}

export interface UntrackedMarker {
  caseId: string;
  status: CaseProgressState;
  detail?: string;
}

export interface PerCaseState {
  /**
   * Per-plan-case state. Domain is exactly the set of plan-block case ids.
   * `sum(countByState(byCase))` always equals `plan.caseCount`.
   */
  byCase: Map<string, CaseProgressState>;
  /**
   * `CASE_*` markers (or finding case_ids) the agent emitted whose ids
   * don't appear in the plan. Surfaced as a footnote in the Plan tab so
   * the user can see the agent did work, without inflating the counts.
   * Latest-wins per `caseId`.
   */
  untracked: UntrackedMarker[];
}

/**
 * Project audit-log + findings + run state into a per-case status map.
 *
 * Rules, in priority order:
 *   1. The latest `case_progress` row for a case is its status.
 *   2. A finding tagged with `case_id: <id>` flips that case to `failed`.
 *   3. For cases with no marker AND no finding, the default is based on
 *      run state: active → `queued`, terminal → `skipped`.
 *   4. A case stuck at `running` after the run terminated is `inconclusive`.
 */
export function derivePerCaseState(opts: {
  plan: TestPlan;
  auditLog: AuditLine[];
  findings: PreviewedFinding[];
  runState: RunState;
}): PerCaseState {
  const planCaseIds = new Set<string>();
  for (const b of opts.plan.blocks) {
    if (b.kind === 'case') planCaseIds.add(b.id);
  }

  const byCase = new Map<string, CaseProgressState>();
  const untrackedLatest = new Map<string, UntrackedMarker>();
  for (const line of opts.auditLog) {
    if (line.kind !== 'case_progress' && line.kind !== 'case_progress_orphan') continue;
    const payload = line.payload as { caseId?: unknown; status?: unknown; detail?: unknown };
    if (typeof payload.caseId !== 'string' || typeof payload.status !== 'string') continue;
    const status = payload.status as CaseProgressState;
    if (planCaseIds.has(payload.caseId)) {
      byCase.set(payload.caseId, status);
    } else {
      const marker: UntrackedMarker = { caseId: payload.caseId, status };
      if (typeof payload.detail === 'string' && payload.detail) marker.detail = payload.detail;
      untrackedLatest.set(payload.caseId, marker);
    }
  }

  for (const f of opts.findings) {
    const id = caseIdFromBody(f.body);
    if (!id) continue;
    if (planCaseIds.has(id)) {
      byCase.set(id, 'failed');
    } else if (!untrackedLatest.has(id)) {
      untrackedLatest.set(id, { caseId: id, status: 'failed' });
    }
  }

  const isCancelled = opts.runState === 'cancelled';
  const isDone = opts.runState === 'done';
  const isFailed = opts.runState === 'failed';
  const isTerminal = isCancelled || isDone || isFailed;

  if (isTerminal) {
    for (const [caseId, state] of byCase) {
      if (state === 'running') byCase.set(caseId, 'inconclusive');
    }
  }

  for (const id of planCaseIds) {
    if (byCase.has(id)) continue;
    byCase.set(id, isTerminal ? 'skipped' : 'queued');
  }

  return { byCase, untracked: Array.from(untrackedLatest.values()) };
}

export function countByState(
  byCase: Map<string, CaseProgressState>,
): Record<CaseProgressState, number> {
  const counts: Record<CaseProgressState, number> = {
    queued: 0,
    running: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const s of byCase.values()) counts[s] += 1;
  return counts;
}
