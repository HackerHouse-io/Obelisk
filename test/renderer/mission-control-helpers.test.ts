import { describe, it, expect } from 'vitest';
import {
  buildActivityRows,
  buildFailureContexts,
  caseIdFromBody,
  countByState,
  derivePerCaseState,
} from '../../src/renderer/screens/mission-control-helpers';
import type {
  AgentEvent,
  AuditLine,
  PreviewedFinding,
  RunState,
  TestPlan,
} from '../../src/shared/types';

function makePlan(caseIds: string[]): TestPlan {
  return {
    frontmatter: {
      id: 'plan-1',
      title: 'Full app sweep',
      version: 1,
    },
    blocks: caseIds.map((id) => ({
      kind: 'case' as const,
      id,
      title: `Case ${id}`,
      expected: null,
      severity: null,
    })),
  } as unknown as TestPlan;
}

function progress(
  caseId: string,
  status: 'running' | 'passed' | 'failed' | 'inconclusive',
  at = '2026-05-08T00:00:00Z',
): AuditLine {
  return {
    id: `audit-${caseId}-${status}`,
    runId: 'run-1',
    at,
    kind: 'case_progress',
    payload: { caseId, status },
  } as unknown as AuditLine;
}

function counts(
  plan: TestPlan,
  auditLog: AuditLine[],
  runState: RunState,
  findings: PreviewedFinding[] = [],
) {
  return countByState(derivePerCaseState({ plan, auditLog, findings, runState }).byCase);
}

describe('derivePerCaseState', () => {
  it('during a live run, unmarked cases are queued', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'passed')];
    const c = counts(plan, log, 'running');
    expect(c).toEqual({ queued: 2, running: 0, passed: 1, failed: 0, inconclusive: 0, skipped: 0 });
  });

  it('during a live run, queued count drops as cases progress', () => {
    const plan = makePlan(['c1', 'c2', 'c3', 'c4']);
    const c0 = counts(plan, [], 'running');
    expect(c0.queued).toBe(4);
    const c1 = counts(plan, [progress('c1', 'running')], 'running');
    expect(c1.queued).toBe(3);
    expect(c1.running).toBe(1);
    const c2 = counts(
      plan,
      [progress('c1', 'running'), progress('c1', 'passed'), progress('c2', 'running')],
      'running',
    );
    expect(c2.queued).toBe(2);
    expect(c2.passed).toBe(1);
    expect(c2.running).toBe(1);
  });

  it('when the run is done with cases that never started, those cases are SKIPPED, not passed', () => {
    // Reproduces the production bug: 41 pass + 3 fail + 1 running + 45 queued
    // would jump to 86 pass at completion. Now the 45 unattempted cases are
    // surfaced as `skipped` instead of silently inflating the pass count.
    const allCases = Array.from({ length: 90 }, (_, i) => `c${i}`);
    const plan = makePlan(allCases);
    const log: AuditLine[] = [];
    for (let i = 0; i < 41; i++) log.push(progress(`c${i}`, 'passed'));
    for (let i = 41; i < 44; i++) log.push(progress(`c${i}`, 'failed'));
    log.push(progress('c44', 'running'));
    const c = counts(plan, log, 'done');
    expect(c.passed).toBe(41); // not 86 — unattempted cases are NOT passed
    expect(c.failed).toBe(3);
    expect(c.skipped).toBe(45); // the cases the agent never reached
    expect(c.inconclusive).toBe(1); // the lone CASE_START with no terminal
    expect(c.running).toBe(0); // a finished run never has live-running cases
    expect(c.queued).toBe(0); // queued only makes sense while the run is live
    expect(c.passed + c.failed + c.skipped + c.inconclusive + c.running + c.queued).toBe(90);
  });

  it('when the run is cancelled, unmarked cases are skipped', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'passed')];
    const c = counts(plan, log, 'cancelled');
    expect(c.passed).toBe(1);
    expect(c.skipped).toBe(2);
    expect(c.queued).toBe(0);
  });

  it('when the run failed, unmarked cases are skipped', () => {
    const plan = makePlan(['c1', 'c2', 'c3']);
    const log = [progress('c1', 'failed')];
    const c = counts(plan, log, 'failed');
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(2);
    expect(c.queued).toBe(0);
  });

  it('a finding tagged with case_id flips that case to failed even without a CASE_FAIL marker', () => {
    const plan = makePlan(['c1', 'c2']);
    const findings = [
      {
        id: 'f1',
        runId: 'run-1',
        body: 'case_id: c2\nFooBar',
        dismissed: false,
      } as unknown as PreviewedFinding,
    ];
    const c = counts(plan, [progress('c1', 'passed')], 'done', findings);
    expect(c.passed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(0);
  });

  it('a case with CASE_START but no terminal marker is inconclusive once the run is done', () => {
    const plan = makePlan(['c1']);
    const c = counts(plan, [progress('c1', 'running')], 'done');
    expect(c.inconclusive).toBe(1);
    expect(c.running).toBe(0);
    expect(c.passed).toBe(0);
  });

  it('matches the QA Hunter case_id marker the orchestrator publishes (HTML comment form)', () => {
    // Closes the loop with the QA Hunter `bodyFor` change: the issue
    // body now ends with `<!-- obelisk:case_id=<id> -->` so historical
    // codex runs (whose CASE_FAIL markers got dropped) still flip the
    // case to `failed` once the issue lands as a finding.
    const plan = makePlan(['01H1', '01H2', '01H3']);
    const findings = [
      {
        id: 'f1',
        runId: 'run-1',
        body:
          '## Description\nLooks bad.\n\n' +
          '## Expected behavior\nWorks.\n\n' +
          '<!-- obelisk:case_id=01H2 -->',
        dismissed: false,
      } as unknown as PreviewedFinding,
    ];
    const c = counts(plan, [progress('01H1', 'passed')], 'done', findings);
    expect(c.passed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(1);
  });

  it('latest case_progress row wins for a given caseId', () => {
    const plan = makePlan(['c1']);
    const log = [
      progress('c1', 'running', '2026-05-08T00:00:00Z'),
      progress('c1', 'passed', '2026-05-08T00:00:01Z'),
    ];
    const c = counts(plan, log, 'running');
    expect(c.passed).toBe(1);
    expect(c.running).toBe(0);
  });

  // Reproduces the screenshot bug: the agent emitted CASE_PASS / CASE_FAIL
  // markers whose ids didn't match the plan's case ids. Pre-fix, the map
  // ended up with `plan.caseCount + off-plan-marker-count` entries — the
  // user saw "28 Pass · 4 Fail · 32 Skipped" for a 32-case plan because
  // every plan id fell through to `skipped` while every off-plan id kept
  // its `passed` / `failed` state in the same map.
  it('off-plan CASE_PASS / CASE_FAIL markers do not count against plan totals', () => {
    const planIds = Array.from({ length: 32 }, (_, i) => `plan-${i}`);
    const plan = makePlan(planIds);
    const log: AuditLine[] = [];
    // Agent emitted 28 passes and 4 fails with IDs that aren't in the plan.
    for (let i = 0; i < 28; i++) log.push(progress(`agent-pass-${i}`, 'passed'));
    for (let i = 0; i < 4; i++) log.push(progress(`agent-fail-${i}`, 'failed'));
    const state = derivePerCaseState({ plan, auditLog: log, findings: [], runState: 'done' });
    const c = countByState(state.byCase);
    expect(c.passed).toBe(0);
    expect(c.failed).toBe(0);
    expect(c.skipped).toBe(32);
    expect(c.passed + c.failed + c.skipped + c.queued + c.running + c.inconclusive).toBe(32);
    // Off-plan markers surface in `untracked` so the user sees the agent
    // did emit them (footnote in the Plan tab).
    expect(state.untracked).toHaveLength(32);
    expect(state.untracked.filter((u) => u.status === 'passed')).toHaveLength(28);
    expect(state.untracked.filter((u) => u.status === 'failed')).toHaveLength(4);
  });

  it('count sum equals plan.caseCount across mixed inputs', () => {
    const planIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const plan = makePlan(planIds);
    const scenarios: { log: AuditLine[]; findings: PreviewedFinding[]; runState: RunState }[] = [
      { log: [], findings: [], runState: 'done' },
      {
        log: [progress('p1', 'passed'), progress('orphan-1', 'passed')],
        findings: [],
        runState: 'done',
      },
      {
        log: [progress('p1', 'failed'), progress('p2', 'running')],
        findings: [
          { id: 1, runId: 'r1', body: 'case_id: p3', dismissed: false } as unknown as PreviewedFinding,
          {
            id: 2,
            runId: 'r1',
            body: 'case_id: not-in-plan',
            dismissed: false,
          } as unknown as PreviewedFinding,
        ],
        runState: 'done',
      },
      {
        log: [progress('p1', 'passed')],
        findings: [],
        runState: 'running',
      },
    ];
    for (const s of scenarios) {
      const state = derivePerCaseState({
        plan,
        auditLog: s.log,
        findings: s.findings,
        runState: s.runState,
      });
      const c = countByState(state.byCase);
      expect(c.passed + c.failed + c.skipped + c.inconclusive + c.queued + c.running).toBe(5);
    }
  });

  it('a finding with a case_id not in the plan does not flip any plan case to failed', () => {
    const plan = makePlan(['p1', 'p2']);
    const findings = [
      {
        id: 1,
        runId: 'r1',
        body: 'case_id: not-in-plan',
        dismissed: false,
      } as unknown as PreviewedFinding,
    ];
    const state = derivePerCaseState({
      plan,
      auditLog: [progress('p1', 'passed')],
      findings,
      runState: 'done',
    });
    const c = countByState(state.byCase);
    expect(c.failed).toBe(0);
    expect(c.passed).toBe(1);
    expect(c.skipped).toBe(1);
    expect(state.untracked).toHaveLength(1);
    expect(state.untracked[0]?.caseId).toBe('not-in-plan');
    expect(state.untracked[0]?.status).toBe('failed');
  });

  it('reads `case_progress_orphan` rows into untracked (orchestrator-emitted)', () => {
    const plan = makePlan(['p1']);
    const orphan: AuditLine = {
      id: 'audit-orphan-1',
      runId: 'r1',
      at: '2026-05-08T00:00:00Z',
      kind: 'case_progress_orphan',
      payload: { caseId: 'phantom', status: 'failed', detail: 'no fixture' },
    } as unknown as AuditLine;
    const state = derivePerCaseState({
      plan,
      auditLog: [progress('p1', 'passed'), orphan],
      findings: [],
      runState: 'done',
    });
    const c = countByState(state.byCase);
    expect(c.passed).toBe(1);
    expect(c.failed).toBe(0);
    expect(state.untracked).toHaveLength(1);
    expect(state.untracked[0]?.detail).toBe('no fixture');
  });
});

describe('caseIdFromBody', () => {
  it('extracts case_id from the qa-hunter HTML comment trailer', () => {
    const body = '## Desc\nbad\n\n<!-- obelisk:case_id=01H1 -->';
    expect(caseIdFromBody(body)).toBe('01H1');
  });

  it('extracts case_id from the legacy free-text form', () => {
    expect(caseIdFromBody('case_id: abc-123\nFooBar')).toBe('abc-123');
    expect(caseIdFromBody('case-id = "foo_bar"')).toBe('foo_bar');
  });

  it('returns null when no case_id is present', () => {
    expect(caseIdFromBody('## Desc\njust prose')).toBeNull();
  });
});

function failingPlan(blocks: {
  id: string;
  title: string;
  expected?: string | null;
  repro?: string | null;
  severity?: 'P0' | 'P1' | 'P2' | null;
}[]): TestPlan {
  return {
    frontmatter: { id: 'p1', title: 'Plan', version: 1 },
    blocks: blocks.map((b) => ({
      kind: 'case' as const,
      id: b.id,
      title: b.title,
      expected: b.expected ?? null,
      repro: b.repro ?? null,
      severity: b.severity ?? null,
    })),
  } as unknown as TestPlan;
}

describe('buildFailureContexts', () => {
  it('joins failed cases against their matching finding via case_id', () => {
    const plan = failingPlan([
      { id: 'c1', title: 'Login flow' },
      { id: 'c2', title: 'Refund flow' },
    ]);
    const log = [progress('c1', 'failed'), progress('c2', 'passed')];
    const findings = [
      {
        id: 1,
        runId: 'r1',
        body: '## Desc\nbroken\n<!-- obelisk:case_id=c1 -->',
        dismissed: false,
      } as unknown as PreviewedFinding,
    ];
    const { byCase } = derivePerCaseState({ plan, auditLog: log, findings, runState: 'done' });
    const ctxs = buildFailureContexts({ plan, byCase, auditLog: log, findings });
    expect(ctxs.size).toBe(1);
    const ctx = ctxs.get('c1');
    expect(ctx?.caseTitle).toBe('Login flow');
    expect(ctx?.finding?.id).toBe(1);
  });

  it('falls back to CASE_FAIL detail when no finding exists for the case', () => {
    const plan = failingPlan([{ id: 'c1', title: 'Login flow', expected: 'lands on home' }]);
    const failWithDetail: AuditLine = {
      id: 'a1',
      runId: 'r1',
      at: '2026-05-08T00:00:00Z',
      kind: 'case_progress',
      payload: { caseId: 'c1', status: 'failed', detail: 'redirects to /login instead' },
    } as unknown as AuditLine;
    const { byCase } = derivePerCaseState({
      plan,
      auditLog: [failWithDetail],
      findings: [],
      runState: 'done',
    });
    const ctxs = buildFailureContexts({
      plan,
      byCase,
      auditLog: [failWithDetail],
      findings: [],
    });
    const ctx = ctxs.get('c1')!;
    expect(ctx.finding).toBeNull();
    expect(ctx.auditDetail).toBe('redirects to /login instead');
    expect(ctx.expected).toBe('lands on home');
  });

  it('does not include passed / skipped / queued cases', () => {
    const plan = failingPlan([
      { id: 'c1', title: 'A' },
      { id: 'c2', title: 'B' },
      { id: 'c3', title: 'C' },
    ]);
    const log = [progress('c1', 'passed'), progress('c2', 'failed')];
    const { byCase } = derivePerCaseState({ plan, auditLog: log, findings: [], runState: 'done' });
    const ctxs = buildFailureContexts({ plan, byCase, auditLog: log, findings: [] });
    expect(Array.from(ctxs.keys())).toEqual(['c2']);
  });
});

function audit(id: number, kind: string, payload: unknown, at = '2026-05-08T00:00:00Z'): AuditLine {
  return { id, runId: 'r1', at, kind, payload } as AuditLine;
}

function event(e: AgentEvent): unknown {
  return e;
}

describe('buildActivityRows', () => {
  it('pairs a tool_call with its tool_result by toolUseId into one tool row', () => {
    const lines: AuditLine[] = [
      audit(
        1,
        'agent_event',
        event({
          type: 'tool_call',
          toolUseId: 'toolu_1',
          name: 'Read',
          input: { file_path: '/a' },
        }),
      ),
      audit(
        2,
        'agent_event',
        event({ type: 'tool_result', toolUseId: 'toolu_1', ok: true, content: 'hello' }),
      ),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'tool') throw new Error('expected tool row');
    expect(rows[0].name).toBe('Read');
    expect(rows[0].result?.content).toBe('hello');
    expect(rows[0].result?.ok).toBe(true);
  });

  it('hides status events by default and reveals them with showAll', () => {
    const lines: AuditLine[] = [
      audit(1, 'agent_event', event({ type: 'session_init', model: 'm' })),
      audit(2, 'agent_event', event({ type: 'status', subtype: 'system:status', raw: {} })),
    ];
    expect(buildActivityRows(lines, false).map((r) => r.kind)).toEqual(['sessionInit']);
    expect(
      buildActivityRows(lines, true)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['sessionInit', 'status']);
  });

  it('drops legacy [system:status] / [user] / [rate_limit_event] placeholders by default', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', '[system:status]'),
      audit(2, 'stdout', '[user]'),
      audit(3, 'stdout', '[rate_limit_event]'),
      audit(4, 'stdout', 'real prose line'),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'thinking') throw new Error('expected thinking row');
    expect(rows[0].text).toBe('real prose line');
  });

  it('coalesces consecutive prose stdout lines into a single thinking row', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'first thought', '2026-05-08T00:00:00Z'),
      audit(2, 'stdout', 'second thought', '2026-05-08T00:00:01Z'),
      audit(3, 'stdout', 'third thought', '2026-05-08T00:00:02Z'),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'thinking') throw new Error('expected thinking row');
    expect(rows[0].text).toBe('first thought\nsecond thought\nthird thought');
    expect(rows[0].at).toBe('2026-05-08T00:00:00Z');
  });

  it('starts a new thinking row when a structured event interrupts the run', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'thinking before tool', '2026-05-08T00:00:00Z'),
      audit(
        2,
        'agent_event',
        event({ type: 'tool_call', toolUseId: 't', name: 'Read', input: { file_path: '/a' } }),
        '2026-05-08T00:00:01Z',
      ),
      audit(
        3,
        'agent_event',
        event({ type: 'tool_result', toolUseId: 't', ok: true, content: 'ok' }),
        '2026-05-08T00:00:02Z',
      ),
      audit(4, 'stdout', 'thinking after tool', '2026-05-08T00:00:03Z'),
    ];
    const rows = buildActivityRows(lines, false);
    // Reverse-chrono: post-tool thinking, paired tool, pre-tool thinking
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'tool', 'thinking']);
    if (rows[0].kind !== 'thinking') throw new Error('expected thinking first');
    expect(rows[0].text).toBe('thinking after tool');
    if (rows[2].kind !== 'thinking') throw new Error('expected thinking last');
    expect(rows[2].text).toBe('thinking before tool');
  });

  it('routes stderr to its own raw row and never bundles it with thinking', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'prose'),
      audit(2, 'stderr', 'oops'),
      audit(3, 'stdout', 'more prose'),
    ];
    const rows = buildActivityRows(lines, false);
    const stderr = rows.find((r) => r.kind === 'raw');
    expect(stderr).toBeDefined();
    if (stderr?.kind !== 'raw') throw new Error('expected raw stderr row');
    expect(stderr.stream).toBe('stderr');
    expect(stderr.text).toBe('oops');
  });

  it('showAll renders one raw row per stdout line — no coalescing', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'a'),
      audit(2, 'stdout', 'b'),
      audit(3, 'stdout', 'c'),
    ];
    const rows = buildActivityRows(lines, true);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === 'raw')).toBe(true);
  });

  it('renders an unmatched tool_result as a standalone tool row', () => {
    const lines: AuditLine[] = [
      audit(
        1,
        'agent_event',
        event({ type: 'tool_result', toolUseId: 'orphan', ok: true, content: '' }),
      ),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'tool') throw new Error('expected tool row');
    expect(rows[0].result?.content).toBe('');
  });

  it('reverses output so newest row is first', () => {
    const lines: AuditLine[] = [
      audit(1, 'agent_event', event({ type: 'session_init' }), '2026-05-08T00:00:00Z'),
      audit(2, 'agent_event', event({ type: 'thinking', text: 'a' }), '2026-05-08T00:00:01Z'),
      audit(3, 'agent_event', event({ type: 'result', ok: true }), '2026-05-08T00:00:02Z'),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows.map((r) => r.kind)).toEqual(['result', 'thinking', 'sessionInit']);
  });

  it('skips empty stdout lines', () => {
    const lines: AuditLine[] = [audit(1, 'stdout', ''), audit(2, 'stdout', 'real')];
    const rows = buildActivityRows(lines, false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'thinking') throw new Error('expected thinking row');
    expect(rows[0].text).toBe('real');
  });

  it('upgrades old runs by re-parsing stdout JSON lines into structured rows', () => {
    // A pre-restructure run persisted each Claude Code stream-json line
    // as `kind:'stdout', payload:<verbatim JSON>`. The renderer should
    // re-classify them so the activity panel still surfaces tool calls
    // and results for old runs.
    const lines: AuditLine[] = [
      audit(
        1,
        'stdout',
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-4-7',
          cwd: '/repo',
          tools: ['Read', 'Edit'],
        }),
      ),
      audit(
        2,
        'stdout',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at the file.' },
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.swift' } },
            ],
          },
        }),
      ),
      audit(
        3,
        'stdout',
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu1',
                content: 'file contents',
                is_error: false,
              },
            ],
          },
        }),
      ),
      audit(
        4,
        'stdout',
        JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1000, num_turns: 1 }),
      ),
    ];
    const rows = buildActivityRows(lines, false);
    // Reverse-chrono: result, tool (paired), thinking, sessionInit
    expect(rows.map((r) => r.kind)).toEqual(['result', 'tool', 'thinking', 'sessionInit']);
    const tool = rows.find((r) => r.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('expected tool row');
    expect(tool.name).toBe('Read');
    expect(tool.result?.content).toBe('file contents');
  });

  it('falls back to thinking when an old-run stdout line is non-JSON prose', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'warning: cli not signed in'),
      audit(2, 'stdout', JSON.stringify({ type: 'system', subtype: 'init', model: 'm' })),
      audit(3, 'stdout', 'a plain prose line after init'),
    ];
    const rows = buildActivityRows(lines, false);
    // Reverse-chrono: thinking (last prose), sessionInit, thinking (first prose)
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'sessionInit', 'thinking']);
  });

  it("emits an event row (collapsible card) when a JSON event is truncated and won't parse", () => {
    // Reproduces the screenshot bug: a tool_result whose content exceeds
    // the OS pipe chunk size was split mid-line by the old unbuffered
    // spawn handler. The fragment looks like a stream-json event but
    // can't be parsed — the renderer should still surface it as a card.
    const truncated =
      '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":"/path/to/very/long/file...';
    const rows = buildActivityRows([audit(1, 'stdout', truncated)], false);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'event') throw new Error('expected event row');
    expect(rows[0].subtype).toBe('user:tool_result');
    expect(rows[0].content).toBe(truncated);
  });

  it('does not flag plain prose as an event row even if it contains a brace', () => {
    const lines: AuditLine[] = [
      audit(1, 'stdout', 'I will use the {brackets} carefully'),
      audit(2, 'stdout', '{ this is also prose, no quoted type field'),
    ];
    const rows = buildActivityRows(lines, false);
    expect(rows.map((r) => r.kind)).toEqual(['thinking']);
  });
});
