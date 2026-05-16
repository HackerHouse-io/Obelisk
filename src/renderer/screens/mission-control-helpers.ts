import type {
  AgentEvent,
  AuditLine,
  CaseProgressState,
  PreviewedFinding,
  RunState,
  TestPlan,
} from '../../shared/types';

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
 *
 * Markers whose `caseId` is not in `plan.blocks` (agent emitted an id we
 * never assigned) are diverted into `untracked` — they don't count
 * against plan totals, but the Plan tab surfaces them so the agent's
 * work isn't silently dropped.
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

  // Cases with CASE_START but no terminal marker: once the run is over,
  // their `running` status is stale. Promote to `inconclusive` so the
  // counts don't show a "live" running case in a finished run.
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

/* ---------- RunCard footer counts (Mission Control list view) ---------- */

export interface PlanCardCounts {
  passed: number;
  failed: number;
  skipped: number;
  inconclusive: number;
  /**
   * Markers the agent emitted whose ids weren't in the plan. Surfaces as a
   * compact "+N untracked" pill so the user knows the agent did work even
   * when the ids didn't match up.
   */
  untracked: number;
}

/**
 * Format pass/fail/skipped pill labels for a plan-driven RunCard footer.
 * Returns null when there's nothing meaningful to show (e.g. a non-plan
 * run or a run whose plan has zero cases). The returned array preserves
 * left-to-right order: pass, fail, then any non-zero modifier pills.
 */
export function formatCardCounts(counts: PlanCardCounts | null): {
  text: string;
  pills: { state: CaseProgressState | 'untracked'; label: string }[];
} | null {
  if (!counts) return null;
  const { passed, failed, skipped, inconclusive, untracked } = counts;
  const pills: { state: CaseProgressState | 'untracked'; label: string }[] = [];
  if (passed > 0) pills.push({ state: 'passed', label: `✓ ${passed}` });
  if (failed > 0) pills.push({ state: 'failed', label: `✗ ${failed}` });
  if (skipped > 0) pills.push({ state: 'skipped', label: `${skipped} skipped` });
  if (inconclusive > 0)
    pills.push({ state: 'inconclusive', label: `${inconclusive} inconclusive` });
  if (untracked > 0) pills.push({ state: 'untracked', label: `+${untracked} untracked` });
  if (pills.length === 0) return null;
  return {
    text: pills.map((p) => p.label).join(' · '),
    pills,
  };
}

/* ---------- Per-case failure detail (Plan tab expansion) ---------- */

export interface FailureContext {
  caseId: string;
  caseTitle: string;
  expected: string | null;
  severity: 'P0' | 'P1' | 'P2' | null;
  repro: string | null;
  /** Linked preview row if a finding's `case_id` matches this case. */
  finding: PreviewedFinding | null;
  /** Latest CASE_FAIL marker detail (`CASE_FAIL <id> (reason)`). */
  auditDetail: string | null;
}

/**
 * Join failed plan cases against their finding (if any) and the latest
 * CASE_FAIL audit row's `detail` text. Used by the Plan tab to render
 * the expanded panel under each failed case.
 */
export function buildFailureContexts(opts: {
  plan: TestPlan;
  byCase: Map<string, CaseProgressState>;
  auditLog: AuditLine[];
  findings: PreviewedFinding[];
}): Map<string, FailureContext> {
  // Index latest CASE_FAIL detail per caseId from the audit log.
  const auditDetailByCase = new Map<string, string>();
  for (const line of opts.auditLog) {
    if (line.kind !== 'case_progress') continue;
    const p = line.payload as { caseId?: unknown; status?: unknown; detail?: unknown };
    if (typeof p.caseId !== 'string' || p.status !== 'failed') continue;
    if (typeof p.detail === 'string' && p.detail.trim()) {
      auditDetailByCase.set(p.caseId, p.detail.trim());
    } else {
      // No detail on this row, but a later CASE_FAIL might have one;
      // record an empty-string placeholder so we don't accidentally
      // surface a stale detail from an earlier row.
      if (!auditDetailByCase.has(p.caseId)) auditDetailByCase.set(p.caseId, '');
    }
  }

  // Index findings by their case_id.
  const findingByCase = new Map<string, PreviewedFinding>();
  for (const f of opts.findings) {
    const id = caseIdFromBody(f.body);
    if (id) findingByCase.set(id, f);
  }

  const out = new Map<string, FailureContext>();
  for (const block of opts.plan.blocks) {
    if (block.kind !== 'case') continue;
    if (opts.byCase.get(block.id) !== 'failed') continue;
    const detail = auditDetailByCase.get(block.id);
    out.set(block.id, {
      caseId: block.id,
      caseTitle: block.title,
      expected: block.expected,
      severity: block.severity,
      repro: block.repro,
      finding: findingByCase.get(block.id) ?? null,
      auditDetail: detail && detail.length > 0 ? detail : null,
    });
  }
  return out;
}

/* ---------- Activity timeline ---------- */

/**
 * One renderable entry in the Activity panel. Goose-inspired: each kind
 * has a dedicated component, no rail / dot timeline. The renderer has no
 * `agent_event` discriminator — this projection has already classified
 * each event into its terminal shape (toolCall paired with its toolResult,
 * thinking turn collected into prose, etc.) so the renderer just maps
 * kind → component.
 */
export type ActivityRow =
  | {
      kind: 'sessionInit';
      key: string;
      at: string;
      model?: string;
      cwd?: string;
      sessionId?: string;
      toolCount?: number;
    }
  | {
      kind: 'thinking';
      key: string;
      at: string;
      text: string;
    }
  | {
      kind: 'tool';
      key: string;
      at: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result?: { content: string; ok: boolean; isError?: boolean };
      resultAt?: string;
    }
  | {
      kind: 'result';
      key: string;
      at: string;
      ok: boolean;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
      text?: string;
    }
  | {
      kind: 'status';
      key: string;
      at: string;
      subtype: string;
      raw: unknown;
    }
  | {
      kind: 'event';
      key: string;
      at: string;
      subtype: string;
      content: string;
    }
  | {
      kind: 'raw';
      key: string;
      at: string;
      stream: 'stdout' | 'stderr';
      text: string;
    };

const NOISE_LABEL_RE = /^\[[\w:_-]+\]$/;

/**
 * Project an audit log into the Activity panel's row stream.
 *
 * Two sources feed this projection:
 *
 * 1. **Structured `agent_event` rows** (new runs) — the parser already
 *    extracted tool_call / tool_result / session_init / etc.
 * 2. **Legacy `stdout` rows** (old runs, pre-structured format) — each
 *    persisted line was a verbatim Claude Code stream-json event that
 *    flowed through the old parser's text fallback. We re-parse those
 *    here so old runs surface tool calls and results too.
 *
 * For both sources:
 * - Pair `tool_call` with its matching `tool_result` (same `toolUseId`).
 * - Accumulate stretches of plain assistant text into a single `thinking`
 *   row, flushed whenever a structured event interrupts the run.
 * - Hide `status` heartbeats and noisy `[label]` placeholder strings
 *   unless `showAll` is true.
 *
 * Walks chronologically (pairing requires call-before-result), reverses
 * at the end so the panel shows newest first.
 */
export function buildActivityRows(lines: AuditLine[], showAll: boolean): ActivityRow[] {
  const pendingCalls = new Map<string, Extract<ActivityRow, { kind: 'tool' }>>();
  const out: ActivityRow[] = [];
  let pendingText: { firstId: number; firstAt: string; parts: string[] } | null = null;

  function flushThinking(): void {
    if (!pendingText) return;
    const text = pendingText.parts.join('\n').trim();
    if (text.length > 0) {
      out.push({
        kind: 'thinking',
        key: `th${pendingText.firstId}`,
        at: pendingText.firstAt,
        text,
      });
    }
    pendingText = null;
  }

  function appendThinking(id: number, at: string, text: string): void {
    if (!pendingText) {
      pendingText = { firstId: id, firstAt: at, parts: [text] };
    } else {
      pendingText.parts.push(text);
    }
  }

  function consumeEvent(id: number, at: string, event: AgentEvent): void {
    switch (event.type) {
      case 'tool_call': {
        flushThinking();
        const row: Extract<ActivityRow, { kind: 'tool' }> = {
          kind: 'tool',
          key: `tc${id}`,
          at,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
        };
        if (event.toolUseId) pendingCalls.set(event.toolUseId, row);
        out.push(row);
        return;
      }
      case 'tool_result': {
        const call = event.toolUseId ? pendingCalls.get(event.toolUseId) : undefined;
        if (call) {
          call.result = { content: event.content, ok: event.ok, isError: event.isError };
          call.resultAt = at;
          pendingCalls.delete(event.toolUseId);
          return;
        }
        flushThinking();
        out.push({
          kind: 'tool',
          key: `tr${id}`,
          at,
          toolUseId: event.toolUseId,
          name: '(tool result)',
          input: null,
          result: { content: event.content, ok: event.ok, isError: event.isError },
          resultAt: at,
        });
        return;
      }
      case 'session_init': {
        flushThinking();
        out.push({
          kind: 'sessionInit',
          key: `si${id}`,
          at,
          model: event.model,
          cwd: event.cwd,
          sessionId: event.sessionId,
          toolCount: event.tools?.length,
        });
        return;
      }
      case 'thinking': {
        appendThinking(id, at, event.text);
        return;
      }
      case 'result': {
        flushThinking();
        out.push({
          kind: 'result',
          key: `r${id}`,
          at,
          ok: event.ok,
          durationMs: event.durationMs,
          turns: event.turns,
          costUsd: event.costUsd,
          text: event.text,
        });
        return;
      }
      case 'status': {
        if (!showAll) return;
        flushThinking();
        out.push({
          kind: 'status',
          key: `st${id}`,
          at,
          subtype: event.subtype ?? 'status',
          raw: event.raw,
        });
        return;
      }
    }
  }

  for (const l of lines) {
    if (l.kind === 'agent_event' && isAgentEvent(l.payload)) {
      consumeEvent(l.id, l.at, l.payload);
      continue;
    }

    if (l.kind === 'stdout' || l.kind === 'stderr') {
      const text = typeof l.payload === 'string' ? l.payload : '';
      if (text.length === 0) continue;

      if (showAll) {
        flushThinking();
        out.push({
          kind: 'raw',
          key: `raw${l.id}`,
          at: l.at,
          stream: l.kind === 'stderr' ? 'stderr' : 'stdout',
          text,
        });
        continue;
      }

      const trimmed = text.trim();
      // Drop the legacy `[type:subtype]` placeholder strings the previous
      // parser persisted in lieu of the actual event content.
      if (NOISE_LABEL_RE.test(trimmed)) continue;

      // Old runs: try to re-classify each persisted line as a stream-json
      // event so we can render their tool calls / results too.
      const upgraded = classifyStreamLine(trimmed);
      if (upgraded) {
        for (const ev of upgraded) consumeEvent(l.id, l.at, ev);
        continue;
      }

      // Looks like a stream-json event but didn't fully parse — typically
      // a giant `tool_result` whose chunks were split mid-line by an
      // unbuffered runner pipe. Surface as an `event` row so the user
      // gets a collapsible card instead of a wall of escaped text.
      const partialKind = looksLikeStreamEvent(trimmed);
      if (partialKind) {
        flushThinking();
        out.push({
          kind: 'event',
          key: `ev${l.id}`,
          at: l.at,
          subtype: partialKind,
          content: text,
        });
        continue;
      }

      // Genuine prose (assistant text deltas, claude warnings, codex
      // output) — feed the thinking accumulator.
      if (l.kind === 'stderr') {
        // Stderr from any runner deserves its own visible row, never
        // hidden under a thinking card.
        flushThinking();
        out.push({
          kind: 'raw',
          key: `err${l.id}`,
          at: l.at,
          stream: 'stderr',
          text,
        });
      } else {
        appendThinking(l.id, l.at, text);
      }
      continue;
    }

    if (l.kind === 'state' && showAll) {
      flushThinking();
      let text: string;
      if (l.payload == null) text = '';
      else if (typeof l.payload === 'string') text = l.payload;
      else {
        try {
          text = JSON.stringify(l.payload);
        } catch {
          text = String(l.payload);
        }
      }
      out.push({
        kind: 'raw',
        key: `s${l.id}`,
        at: l.at,
        stream: 'stdout',
        text: `state · ${text}`,
      });
    }
  }
  flushThinking();

  return out.reverse();
}

export function isAgentEvent(payload: unknown): payload is AgentEvent {
  if (!payload || typeof payload !== 'object') return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === 'session_init' ||
    t === 'thinking' ||
    t === 'tool_call' ||
    t === 'tool_result' ||
    t === 'status' ||
    t === 'result'
  );
}

/**
 * Re-parse a single persisted stdout line as a Claude Code stream-json
 * event. Returns `null` when the line isn't valid JSON or doesn't match a
 * known shape — those fall through as plain prose. May return multiple
 * events for one line (e.g. an assistant message that bundles a text
 * block plus several tool_use blocks).
 *
 * Mirrors the classification logic in `claude-stream-json.ts`. Kept in
 * sync by hand; both exhaustively cover the same shapes (system:init,
 * stream_event text deltas, assistant content blocks, user tool_result
 * blocks, result envelope, anything else → status).
 */
function classifyStreamLine(line: string): AgentEvent[] | null {
  if (line.length < 2 || (line[0] !== '{' && line[0] !== '[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];

  if (type === 'stream_event') {
    const inner = obj['event'] as Record<string, unknown> | undefined;
    if (inner && inner['type'] === 'content_block_delta') {
      const delta = inner['delta'] as Record<string, unknown> | undefined;
      if (delta && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        return [{ type: 'thinking', text: delta['text'] }];
      }
    }
    return null;
  }

  if (type === 'assistant') {
    const message = obj['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (!Array.isArray(content)) return null;
    const events: AgentEvent[] = [];
    let text = '';
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as Record<string, unknown>;
      if (part['type'] === 'text' && typeof part['text'] === 'string') {
        text += (text ? '\n' : '') + part['text'];
      } else if (part['type'] === 'tool_use') {
        events.push({
          type: 'tool_call',
          toolUseId: typeof part['id'] === 'string' ? part['id'] : '',
          name: typeof part['name'] === 'string' ? part['name'] : 'tool',
          input: part['input'] ?? {},
        });
      }
    }
    if (text.length > 0) events.unshift({ type: 'thinking', text });
    return events.length > 0 ? events : null;
  }

  if (type === 'user') {
    const message = obj['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (!Array.isArray(content)) return null;
    const events: AgentEvent[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as Record<string, unknown>;
      if (part['type'] !== 'tool_result') continue;
      const isError = part['is_error'] === true;
      events.push({
        type: 'tool_result',
        toolUseId: typeof part['tool_use_id'] === 'string' ? part['tool_use_id'] : '',
        ok: !isError,
        isError,
        content: stringifyToolResult(part['content']),
      });
    }
    return events.length > 0 ? events : null;
  }

  if (type === 'system' && obj['subtype'] === 'init') {
    const event: AgentEvent = { type: 'session_init' };
    if (typeof obj['model'] === 'string') event.model = obj['model'];
    if (typeof obj['cwd'] === 'string') event.cwd = obj['cwd'];
    if (typeof obj['session_id'] === 'string') event.sessionId = obj['session_id'];
    if (Array.isArray(obj['tools'])) {
      event.tools = (obj['tools'] as unknown[]).filter((t): t is string => typeof t === 'string');
    }
    return [event];
  }

  if (type === 'result') {
    const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : undefined;
    const ok = subtype !== 'error_max_turns' && subtype !== 'error_during_execution';
    const event: AgentEvent = { type: 'result', ok };
    if (typeof obj['duration_ms'] === 'number') event.durationMs = obj['duration_ms'];
    if (typeof obj['num_turns'] === 'number') event.turns = obj['num_turns'];
    if (typeof obj['total_cost_usd'] === 'number') event.costUsd = obj['total_cost_usd'];
    if (typeof obj['result'] === 'string') event.text = obj['result'];
    return [event];
  }

  if (typeof type === 'string') {
    const subtype = typeof obj['subtype'] === 'string' ? `${type}:${obj['subtype']}` : type;
    return [{ type: 'status', subtype, raw: obj }];
  }

  return null;
}

/**
 * Cheap regex peek: does this line LOOK like a stream-json event we'd
 * normally parse? Used as a fallback when JSON.parse fails on a partial
 * line so we still surface it as a structured (collapsible) row instead
 * of dumping raw text into a thinking card.
 *
 * Returns the event "subtype" (e.g. `user:tool_result`, `assistant`,
 * `system:init`) or null when the line isn't event-shaped.
 */
function looksLikeStreamEvent(line: string): string | null {
  if (line.length < 2 || line[0] !== '{') return null;
  const typeMatch = /^\{\s*"type"\s*:\s*"([\w_]+)"/.exec(line);
  const type = typeMatch?.[1];
  if (!type) return null;
  if (type === 'user' && /"type"\s*:\s*"tool_result"/.test(line)) return 'user:tool_result';
  if (type === 'user') return 'user';
  if (type === 'assistant') return 'assistant';
  if (type === 'system') {
    const sub = /"subtype"\s*:\s*"([\w_]+)"/.exec(line)?.[1];
    return sub ? `system:${sub}` : 'system';
  }
  if (type === 'result') return 'result';
  return type;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as Record<string, unknown>;
      if (part['type'] === 'text' && typeof part['text'] === 'string') parts.push(part['text']);
      else if (part['type'] === 'image') parts.push('[image]');
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
