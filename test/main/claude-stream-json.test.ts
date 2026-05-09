import { describe, it, expect } from 'vitest';
import { ClaudeStreamParser } from '../../src/main/runners/claude-stream-json';
import type { AgentEvent } from '../../src/shared/types';

function feed(lines: string[]) {
  const text: string[] = [];
  const events: AgentEvent[] = [];
  const parser = new ClaudeStreamParser({
    onText: (l) => text.push(l),
    onEvent: (e) => events.push(e),
  });
  for (const l of lines) parser.feedLine(l);
  parser.flush();
  return { text, events, reasoning: parser.reasoning() };
}

describe('ClaudeStreamParser', () => {
  it('emits session_init with model/cwd/tools/sessionId', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-7',
        cwd: '/tmp/work',
        session_id: 'sess-abc',
        tools: ['Read', 'Edit', 'Bash'],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session_init',
      model: 'claude-sonnet-4-7',
      cwd: '/tmp/work',
      sessionId: 'sess-abc',
      tools: ['Read', 'Edit', 'Bash'],
    });
  });

  it('extracts tool_call events from the assistant message', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will read the file.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: '/repo/foo.swift' },
            },
          ],
        },
      }),
    ]);
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      toolUseId: 'toolu_1',
      name: 'Read',
      input: { file_path: '/repo/foo.swift' },
    });
  });

  it('emits a thinking event when assistant text arrives without streaming deltas', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Considering the bug...' }] },
      }),
    ]);
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
  });

  it('does NOT emit a thinking event when streaming deltas already covered the text', () => {
    const { events, text } = feed([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial line\n' },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial line' }] },
      }),
    ]);
    expect(text).toContain('partial line');
    expect(events.some((e) => e.type === 'thinking')).toBe(false);
  });

  it('extracts tool_result events from the user turn', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'file contents here',
              is_error: false,
            },
          ],
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      ok: true,
      isError: false,
      content: 'file contents here',
    });
  });

  it('flattens array-form tool_result content (text blocks)', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'line a' },
                { type: 'text', text: 'line b' },
              ],
            },
          ],
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      ok: true,
      content: 'line a\nline b',
    });
  });

  it('marks tool_result with is_error:true as not ok', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_3',
              content: 'exit 1',
              is_error: true,
            },
          ],
        },
      }),
    ]);
    expect(events[0]).toMatchObject({ type: 'tool_result', ok: false, isError: true });
  });

  it('emits a result event with duration/turns/cost', () => {
    const { events } = feed([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 12345,
        num_turns: 3,
        total_cost_usd: 0.42,
        result: 'done',
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'result',
      ok: true,
      durationMs: 12345,
      turns: 3,
      costUsd: 0.42,
      text: 'done',
    });
  });

  it('marks result with error_max_turns subtype as not ok', () => {
    const { events } = feed([JSON.stringify({ type: 'result', subtype: 'error_max_turns' })]);
    expect(events[0]).toMatchObject({ type: 'result', ok: false });
  });

  it('falls back to a status event for unknown system subtypes', () => {
    const { events } = feed([JSON.stringify({ type: 'system', subtype: 'status', payload: 1 })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', subtype: 'system:status' });
  });

  it('never emits the legacy [type:subtype] label strings', () => {
    const { events, text } = feed([
      JSON.stringify({ type: 'system', subtype: 'status' }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      }),
    ]);
    // Status should be a structured event, not a literal label string.
    expect(text).not.toContain('[system:status]');
    expect(text).not.toContain('[user]');
    for (const e of events) {
      // No event type produces the literal placeholder.
      expect(JSON.stringify(e)).not.toMatch(/^\["\[system:status\]"\]$/);
    }
  });

  it('forwards plain non-JSON lines through onText (claude pre-stream warnings)', () => {
    const { text, events } = feed(['warning: cannot find local config']);
    expect(text).toEqual(['warning: cannot find local config']);
    expect(events).toHaveLength(0);
  });

  it('streams text deltas into onText line by line', () => {
    const { text } = feed([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'first line\nsecond ' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'line\n' },
        },
      }),
    ]);
    expect(text).toEqual(['first line', 'second line']);
  });
});
