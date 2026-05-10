import { describe, it, expect } from 'vitest';
import { CodexStreamParser } from '../../src/main/runners/codex-stream-json';
import type { AgentEvent } from '../../src/shared/types';

function feed(lines: string[]) {
  const text: string[] = [];
  const events: AgentEvent[] = [];
  const parser = new CodexStreamParser({
    onText: (l) => text.push(l),
    onEvent: (e) => events.push(e),
  });
  for (const l of lines) parser.feedLine(l);
  parser.flush();
  return { text, events, reasoning: parser.reasoning() };
}

describe('CodexStreamParser', () => {
  it('emits session_init from thread.started', () => {
    const { events } = feed([JSON.stringify({ type: 'thread.started', thread_id: 'th-1' })]);
    expect(events).toEqual([{ type: 'session_init', sessionId: 'th-1' }]);
  });

  it('projects command_execution items into Bash tool_call + tool_result', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'ls -la',
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'ls -la',
          aggregated_output: 'foo\nbar',
          exit_code: 0,
          status: 'completed',
        },
      }),
    ]);
    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(calls).toHaveLength(2); // started + completed both project a tool_call (paired by id)
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      toolUseId: 'item_1',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'item_1',
      ok: true,
      content: 'foo\nbar',
    });
  });

  it('marks non-zero exit codes as failed tool_results', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: 'false',
          aggregated_output: 'boom',
          exit_code: 1,
          status: 'completed',
        },
      }),
    ]);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', ok: false, isError: true });
  });

  it('maps file_change items to Edit when any path is updated', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'file_change',
          changes: [
            { path: '/tmp/a.md', kind: 'update' },
            { path: '/tmp/b.py', kind: 'add' },
          ],
          status: 'completed',
        },
      }),
    ]);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({
      type: 'tool_call',
      name: 'Edit',
      input: { file_path: '/tmp/a.md' },
    });
  });

  it('maps file_change items with all `add` kinds to Write', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_4',
          type: 'file_change',
          changes: [{ path: '/tmp/new.py', kind: 'add' }],
          status: 'completed',
        },
      }),
    ]);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', name: 'Write' });
  });

  it('streams agent_message text line-by-line through onText (case-progress markers)', () => {
    // Regression: codex used to emit a single `thinking` event for the
    // whole turn and never call onText, so the case-progress tracker
    // (line-based) never saw QA Hunter's CASE_START / CASE_PASS markers.
    // Result: every codex-driven QA run shipped every case as `skipped`.
    // The fix streams each line through onText AND drops the bulk
    // `thinking` event to avoid double-rendering in the activity tab.
    const { text, events, reasoning } = feed([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: 'CASE_START 01H1\nLooking at auth/session.ts\nCASE_PASS 01H1',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_5', type: 'agent_message', text: 'all done' },
      }),
    ]);
    expect(text).toEqual([
      'CASE_START 01H1',
      'Looking at auth/session.ts',
      'CASE_PASS 01H1',
      'all done',
    ]);
    // No bulk `thinking` event for the same text — it would double up in
    // the audit log and the Activity tab.
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(0);
    // Reasoning still aggregates the full text for BEGIN_FINDINGS parsing.
    expect(reasoning).toBe(
      'CASE_START 01H1\nLooking at auth/session.ts\nCASE_PASS 01H1\nall done',
    );
  });

  it('emits a result event from turn.completed with token totals', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 50,
          output_tokens: 30,
          reasoning_output_tokens: 20,
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', ok: true });
    expect((events[0] as { text?: string }).text).toContain('150');
  });

  it('forwards plain non-JSON lines through onText (codex pre-stream banner)', () => {
    const { text, events } = feed(['Reading additional input from stdin...']);
    expect(text).toEqual(['Reading additional input from stdin...']);
    expect(events).toHaveLength(0);
  });

  it('falls back to a status event for unknown top-level types', () => {
    const { events } = feed([JSON.stringify({ type: 'turn.started' })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', subtype: 'turn.started' });
  });

  it('preserves unknown item kinds as a tool_call with the kind as the name', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_99', type: 'mystery_kind', payload: 42 },
      }),
    ]);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', name: 'mystery_kind' });
  });
});
