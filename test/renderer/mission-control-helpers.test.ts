import { describe, it, expect } from 'vitest';
import {
  buildActivityRows,
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
  return countByState(derivePerCaseState({ plan, auditLog, findings, runState }));
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
    expect(buildActivityRows(lines, true).map((r) => r.kind).sort()).toEqual([
      'sessionInit',
      'status',
    ]);
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
              { type: 'tool_result', tool_use_id: 'tu1', content: 'file contents', is_error: false },
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
      audit(
        2,
        'stdout',
        JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }),
      ),
      audit(3, 'stdout', 'a plain prose line after init'),
    ];
    const rows = buildActivityRows(lines, false);
    // Reverse-chrono: thinking (last prose), sessionInit, thinking (first prose)
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'sessionInit', 'thinking']);
  });
});
