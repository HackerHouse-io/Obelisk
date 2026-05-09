/**
 * Parse Claude Code's `--output-format stream-json --include-partial-messages`
 * output into events the rest of the orchestrator can consume.
 *
 * The parser produces two kinds of output:
 *
 * 1. **Plain text** via `onText`, used by:
 *    - The case-progress tracker (line-based BEGIN/END marker matcher).
 *    - The reasoning buffer that feeds BEGIN_FINDINGS extraction.
 *    Sourced from streaming `text_delta` events; falls back to the final
 *    `assistant.message.content[].text` blocks when the runtime doesn't
 *    honour `--include-partial-messages` (older claude versions).
 *
 * 2. **Structured agent events** via `onEvent`, surfaced in Mission Control's
 *    Activity timeline. Each event is one user-visible step (tool call, tool
 *    result, session init, final result). Tool-use IDs let the renderer pair
 *    a `tool_call` with its matching `tool_result`.
 *
 * Anything we can't classify falls through as `{type:'status'}` so it is
 * persisted but hidden by default — never lost, never rendered as noise.
 */

import type { AgentEvent } from '../../shared/types';

export interface ClaudeStreamParserOpts {
  /** Fired for every completed line of extracted assistant text. */
  onText: (line: string) => void;
  /** Fired for each structured agent event extracted from the stream. */
  onEvent?: (event: AgentEvent) => void;
}

export class ClaudeStreamParser {
  private deltaBuf = '';
  private finalText: string[] = [];
  private pending = '';
  private sawDeltas = false;

  constructor(private readonly opts: ClaudeStreamParserOpts) {}

  /**
   * Feed one stdout line (already trimmed of its trailing newline by spawn.ts).
   * Non-JSON lines are forwarded as-is — handles the case where claude
   * prints a plain warning before the JSON stream begins.
   */
  feedLine(line: string): void {
    if (line.length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Plain text — pass through verbatim. The text-mode case-progress
      // parser is line-based; an unwrapped line still lets it match.
      this.opts.onText(line);
      return;
    }
    this.consumeEvent(event);
  }

  /**
   * Drain any partial line still buffered without a trailing newline so a
   * marker that arrived right at the end of stdout still fires.
   */
  flush(): void {
    if (this.pending.length > 0) {
      this.opts.onText(this.pending);
      this.pending = '';
    }
  }

  /**
   * Returns the accumulated assistant text. Used by the runner as the
   * `reasoning` payload that feeds into BEGIN_FINDINGS parsing. Prefers
   * the streamed delta buffer (line-faithful) and falls back to the joined
   * final-assistant text when no deltas were observed.
   */
  reasoning(): string {
    return this.sawDeltas ? this.deltaBuf : this.finalText.join('\n');
  }

  private consumeEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const obj = event as Record<string, unknown>;
    const type = obj['type'];

    // Path 1 — streaming text deltas.
    if (type === 'stream_event') {
      const inner = obj['event'] as Record<string, unknown> | undefined;
      if (inner && inner['type'] === 'content_block_delta') {
        const delta = inner['delta'] as Record<string, unknown> | undefined;
        if (delta && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          this.appendDelta(delta['text']);
        }
      }
      return;
    }

    // Path 2 — final assistant message. Walks content blocks: text feeds
    // the fallback reasoning buffer; tool_use blocks become structured
    // tool_call events.
    if (type === 'assistant') {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return;
      let assistantText = '';
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as Record<string, unknown>;
        if (part['type'] === 'text' && typeof part['text'] === 'string') {
          this.finalText.push(part['text']);
          assistantText += (assistantText ? '\n' : '') + part['text'];
        } else if (part['type'] === 'tool_use') {
          this.emit({
            type: 'tool_call',
            toolUseId: stringField(part, 'id') ?? '',
            name: stringField(part, 'name') ?? 'tool',
            input: part['input'] ?? {},
          });
        }
      }
      // Surface a `thinking` event when the assistant turn carried text
      // but no streaming deltas reached us — older claude versions, or
      // when text is short enough that the final-message path arrives
      // first. Avoids duplicating the assistant turn that already streamed.
      if (!this.sawDeltas && assistantText.length > 0) {
        this.emit({ type: 'thinking', text: assistantText });
      }
      return;
    }

    // Path 3 — user turn from claude (i.e. the model's tool_result reply
    // that closes a tool call). Carries `tool_result` blocks.
    if (type === 'user') {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return;
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as Record<string, unknown>;
        if (part['type'] !== 'tool_result') continue;
        const isError = part['is_error'] === true;
        this.emit({
          type: 'tool_result',
          toolUseId: stringField(part, 'tool_use_id') ?? '',
          ok: !isError,
          isError,
          content: stringifyToolResultContent(part['content']),
        });
      }
      return;
    }

    // Path 4 — session init metadata.
    if (type === 'system' && obj['subtype'] === 'init') {
      const event: AgentEvent = { type: 'session_init' };
      const model = stringField(obj, 'model');
      if (model) event.model = model;
      const cwd = stringField(obj, 'cwd');
      if (cwd) event.cwd = cwd;
      const sessionId = stringField(obj, 'session_id');
      if (sessionId) event.sessionId = sessionId;
      const tools = obj['tools'];
      if (Array.isArray(tools)) {
        event.tools = tools.filter((t): t is string => typeof t === 'string');
      }
      this.emit(event);
      return;
    }

    // Path 5 — final result envelope.
    if (type === 'result') {
      const subtype = stringField(obj, 'subtype');
      const ok = subtype !== 'error_max_turns' && subtype !== 'error_during_execution';
      const event: AgentEvent = { type: 'result', ok };
      if (typeof obj['duration_ms'] === 'number') event.durationMs = obj['duration_ms'] as number;
      if (typeof obj['num_turns'] === 'number') event.turns = obj['num_turns'] as number;
      if (typeof obj['total_cost_usd'] === 'number') {
        event.costUsd = obj['total_cost_usd'] as number;
      }
      const text = stringField(obj, 'result');
      if (text) event.text = text;
      this.emit(event);
      return;
    }

    // Path 6 — anything we don't recognise (system:status heartbeats,
    // future event types). Persisted as a status event so nothing is lost,
    // but the renderer hides these unless the user toggles "Show all".
    if (typeof type === 'string') {
      const subtype = stringField(obj, 'subtype');
      const event: AgentEvent = { type: 'status', raw: obj };
      if (subtype) event.subtype = `${type}:${subtype}`;
      else event.subtype = type;
      this.emit(event);
    }
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  private appendDelta(text: string): void {
    this.sawDeltas = true;
    this.deltaBuf += text;
    this.pending += text;
    let idx = this.pending.indexOf('\n');
    while (idx !== -1) {
      const completed = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      if (completed.length > 0) this.opts.onText(completed);
      idx = this.pending.indexOf('\n');
    }
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * tool_result `content` is either a plain string or an array of content
 * blocks (text / image). Flatten to a single string for the audit log;
 * the renderer can wrap or truncate as needed.
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as Record<string, unknown>;
      if (part['type'] === 'text' && typeof part['text'] === 'string') {
        parts.push(part['text']);
      } else if (part['type'] === 'image') {
        parts.push('[image]');
      }
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
