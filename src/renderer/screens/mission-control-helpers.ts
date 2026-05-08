import type {
  AuditLine,
  CaseProgressState,
  PreviewedFinding,
  RunState,
  TestPlan,
} from '../../shared/types';

/**
 * Project audit-log + findings + run state into a per-case status map.
 *
 * Rules, in priority order:
 *   1. The latest `case_progress` row for a case is its status.
 *   2. A finding tagged with `case_id: <id>` flips that case to `failed`
 *      (catches agents that file findings without streaming markers).
 *   3. For cases with no marker AND no finding, the default is based on
 *      run state:
 *      - run still active → `queued` (the agent hasn't reached it yet)
 *      - run terminated (done / failed / cancelled) → `skipped` (the
 *        agent finished without ever attempting this case — we don't
 *        claim it passed, because we have no evidence either way).
 *   4. A case stuck at `running` after the run terminated is treated as
 *      `inconclusive` — the agent emitted CASE_START but never a
 *      terminal marker, so the outcome is genuinely unknown.
 *
 * The historical bug this guards against: marking unattempted cases as
 * `passed` once `runState === 'done'` inflates the pass count by every
 * case the agent never reached, doubling the visible "Pass" total at
 * completion.
 */
export function derivePerCaseState(opts: {
  plan: TestPlan;
  auditLog: AuditLine[];
  findings: PreviewedFinding[];
  runState: RunState;
}): Map<string, CaseProgressState> {
  const map = new Map<string, CaseProgressState>();
  for (const line of opts.auditLog) {
    if (line.kind !== 'case_progress') continue;
    const payload = line.payload as { caseId?: unknown; status?: unknown };
    if (typeof payload.caseId === 'string' && typeof payload.status === 'string') {
      map.set(payload.caseId, payload.status as CaseProgressState);
    }
  }

  const failedByFinding = new Set<string>();
  for (const f of opts.findings) {
    const m = /case[_-]?id\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i.exec(f.body);
    if (m && m[1]) failedByFinding.add(m[1]);
  }
  for (const block of opts.plan.blocks) {
    if (block.kind !== 'case') continue;
    if (failedByFinding.has(block.id)) {
      map.set(block.id, 'failed');
    }
  }

  const isCancelled = opts.runState === 'cancelled';
  const isDone = opts.runState === 'done';
  const isFailed = opts.runState === 'failed';
  const isTerminal = isCancelled || isDone || isFailed;

  // Cases with CASE_START but no terminal marker: once the run is over,
  // their `running` status is stale. Promote to `inconclusive` so the
  // counts don't show a "live" running case in a finished run.
  if (isTerminal) {
    for (const [caseId, state] of map) {
      if (state === 'running') map.set(caseId, 'inconclusive');
    }
  }

  for (const block of opts.plan.blocks) {
    if (block.kind !== 'case') continue;
    if (map.has(block.id)) continue;
    if (isTerminal) {
      map.set(block.id, 'skipped');
    } else {
      map.set(block.id, 'queued');
    }
  }
  return map;
}

export function countByState(
  map: Map<string, CaseProgressState>,
): Record<CaseProgressState, number> {
  const counts: Record<CaseProgressState, number> = {
    queued: 0,
    running: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const s of map.values()) counts[s] += 1;
  return counts;
}
