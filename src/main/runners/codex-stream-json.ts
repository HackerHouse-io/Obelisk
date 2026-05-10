/**
 * Parse Codex `exec --json` JSONL output into the same `AgentEvent`
 * shapes Mission Control's Activity tab already understands. Mirrors
 * `claude-stream-json.ts` so both runners feed the same renderer:
 * `tool_call` paired with `tool_result`, `thinking` for assistant prose,
 * `session_init` at the start, `result` at the end.
 *
 * Codex's event vocabulary (one JSON object per line):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_N","type":"<kind>",...}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"<kind>",...}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Item kinds we care about:
 *   - `agent_message` (text)        → thinking
 *   - `reasoning`     (text)        → thinking
 *   - `command_execution`           → Bash tool_call/tool_result
 *   - `local_shell`                 → Bash tool_call/tool_result
 *   - `file_change` / `patch`       → Edit / Write tool_call/tool_result
 *   - `mcp_tool_call`               → tool_call/tool_result with item-supplied name
 *   - `web_search`                  → WebSearch tool_call/tool_result
 *   - `web_fetch` / `browse`        → WebFetch tool_call/tool_result
 *   - `todo_list`                   → TodoWrite tool_call/tool_result
 *   - `sub_agent`                   → Task tool_call/tool_result
 *
 * Anything we don't recognise becomes a `status` event so it's persisted
 * but hidden by default — never lost, never rendered as noise.
 */

import type { AgentEvent } from '../../shared/types';

export interface CodexStreamParserOpts {
  /** Fired for every line of plain assistant text we extract (BEGIN/END marker matchers run on this). */
  onText: (line: string) => void;
  /** Fired for every structured agent event we project from the stream. */
  onEvent?: (event: AgentEvent) => void;
}

export class CodexStreamParser {
  private finalText: string[] = [];

  constructor(private readonly opts: CodexStreamParserOpts) {}

  /**
   * Feed one stdout line (already trimmed of its trailing newline by spawn.ts).
   * Non-JSON lines forward through `onText` verbatim — handles codex's
   * pre-stream "Reading additional input from stdin..." banner.
   */
  feedLine(line: string): void {
    if (line.length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.opts.onText(line);
      return;
    }
    this.consumeEvent(event);
  }

  /** Symmetry with ClaudeStreamParser; codex has no partial-line buffer. */
  flush(): void {}

  /**
   * Joined assistant text, used by the runner as the `reasoning` payload
   * fed into BEGIN_FINDINGS parsing. Codex doesn't stream deltas, so we
   * only have the completed `agent_message` items to draw from.
   */
  reasoning(): string {
    return this.finalText.join('\n');
  }

  private consumeEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const obj = event as Record<string, unknown>;
    const type = obj['type'];

    if (type === 'thread.started') {
      const ev: AgentEvent = { type: 'session_init' };
      const id = stringField(obj, 'thread_id');
      if (id) ev.sessionId = id;
      this.emit(ev);
      return;
    }

    if (type === 'turn.completed') {
      const ev: AgentEvent = { type: 'result', ok: true };
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        // Codex doesn't report wall-clock duration or USD cost — the
        // renderer hides absent fields so leaving them undefined is fine.
        const inputTokens = numberField(usage, 'input_tokens');
        const outputTokens = numberField(usage, 'output_tokens');
        const reasoningTokens = numberField(usage, 'reasoning_output_tokens');
        const total = (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0);
        if (total > 0) ev.text = `${total.toLocaleString()} tokens`;
      }
      this.emit(ev);
      return;
    }

    if (type === 'item.started') {
      const item = obj['item'] as Record<string, unknown> | undefined;
      if (!item) return;
      const projected = this.projectItemAsToolCall(item);
      if (projected) this.emit(projected);
      return;
    }

    if (type === 'item.completed') {
      const item = obj['item'] as Record<string, unknown> | undefined;
      if (!item) return;

      // Plain assistant text — stream each line through `onText` so the
      // activity tab gets it (`stdout` audit rows render as `thinking`
      // cards via `mission-control-helpers.ts:buildActivityRows`) AND so
      // the case-progress tracker sees QA agents' `CASE_START` /
      // `CASE_PASS` / `CASE_FAIL` markers line-by-line. The
      // case-progress tracker is line-based — without this per-line
      // fan-out, every codex run shipped every case as `skipped`
      // because no `case_progress` row ever landed (the Claude path
      // already does this via `text_delta` streaming).
      //
      // Deliberately NOT emitting a separate `thinking` event for the
      // same text: that would duplicate the text in the audit log AND
      // double-render it in the Activity tab (the tab pushes both
      // `agent_event:thinking` and `stdout` into the same accumulator).
      // Mirrors Claude's `sawDeltas` short-circuit at
      // `claude-stream-json.ts:124`.
      const itemType = stringField(item, 'type');
      if (itemType === 'agent_message' || itemType === 'reasoning') {
        const text = stringField(item, 'text') ?? stringField(item, 'content');
        if (text) {
          this.finalText.push(text);
          for (const line of text.split(/\r?\n/)) {
            if (line.length > 0) this.opts.onText(line);
          }
        }
        return;
      }

      // Tool-shaped item — emit a tool_call (in case `item.started` was
      // skipped, which happens when codex reports the whole step in one
      // shot) followed by a tool_result with the same toolUseId.
      const call = this.projectItemAsToolCall(item);
      if (call) this.emit(call);

      const result = this.projectItemAsToolResult(item);
      if (result) this.emit(result);
      return;
    }

    // turn.started, anything else — preserve as a status row so nothing
    // is silently dropped. Hidden unless the user toggles "Show all".
    if (typeof type === 'string') {
      this.emit({ type: 'status', subtype: type, raw: obj });
    }
  }

  /**
   * Build a `tool_call` event from a codex item. Returns null when the
   * item kind is text-only (agent_message/reasoning) — those are surfaced
   * as `thinking`, not as tool calls.
   */
  private projectItemAsToolCall(item: Record<string, unknown>): AgentEvent | null {
    const id = stringField(item, 'id') ?? '';
    const itemType = stringField(item, 'type') ?? 'tool';
    if (itemType === 'agent_message' || itemType === 'reasoning') return null;

    const { name, input } = mapItemToTool(itemType, item);
    return {
      type: 'tool_call',
      toolUseId: id,
      name,
      input,
    };
  }

  private projectItemAsToolResult(item: Record<string, unknown>): AgentEvent | null {
    const id = stringField(item, 'id') ?? '';
    const itemType = stringField(item, 'type') ?? 'tool';
    if (itemType === 'agent_message' || itemType === 'reasoning') return null;

    const { content, ok } = mapItemToToolResult(itemType, item);
    return {
      type: 'tool_result',
      toolUseId: id,
      ok,
      isError: !ok,
      content,
    };
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Map a codex item to the `(toolName, input)` shape the renderer expects.
 * Mission Control's `describeToolCall` recognises Read / Edit / Write /
 * Bash / Grep / TodoWrite / Task / WebFetch / WebSearch — we lean into
 * those names so the activity rows look identical to Claude Code's.
 */
function mapItemToTool(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: unknown } {
  switch (itemType) {
    case 'command_execution':
    case 'local_shell': {
      const command = stringField(item, 'command') ?? '';
      return { name: 'Bash', input: { command } };
    }
    case 'file_change':
    case 'patch': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const first = changes[0] as Record<string, unknown> | undefined;
      const path = first ? stringField(first, 'path') : undefined;
      // Surface a single representative path even when codex bundled
      // multiple files into one patch — the renderer collapses to that
      // path; the full list lives in the input payload for the detail view.
      const allAdds =
        changes.length > 0 &&
        changes.every((c) => {
          if (!c || typeof c !== 'object') return false;
          return (c as Record<string, unknown>)['kind'] === 'add';
        });
      const name = allAdds ? 'Write' : 'Edit';
      return {
        name,
        input: {
          file_path: path ?? '',
          changes,
        },
      };
    }
    case 'mcp_tool_call': {
      const name =
        stringField(item, 'tool_name') ??
        stringField(item, 'name') ??
        stringField(item, 'server') ??
        'mcp_tool';
      const args = item['arguments'] ?? item['input'] ?? item['args'] ?? {};
      return { name, input: args };
    }
    case 'web_search': {
      const query = stringField(item, 'query') ?? stringField(item, 'q') ?? '';
      return { name: 'WebSearch', input: { query } };
    }
    case 'web_fetch':
    case 'browse': {
      const url = stringField(item, 'url') ?? '';
      return { name: 'WebFetch', input: { url } };
    }
    case 'todo_list': {
      return { name: 'TodoWrite', input: { items: item['items'] ?? item['tasks'] ?? [] } };
    }
    case 'sub_agent': {
      const description =
        stringField(item, 'description') ?? stringField(item, 'task') ?? 'sub-agent';
      return { name: 'Task', input: { description } };
    }
    default:
      // Unknown item kind — preserve the raw payload so the detail panel
      // still has something useful to show.
      return { name: itemType || 'tool', input: item };
  }
}

function mapItemToToolResult(
  itemType: string,
  item: Record<string, unknown>,
): { content: string; ok: boolean } {
  switch (itemType) {
    case 'command_execution':
    case 'local_shell': {
      const output = stringField(item, 'aggregated_output') ?? stringField(item, 'output') ?? '';
      const exitCode = numberField(item, 'exit_code');
      const ok = exitCode === undefined ? true : exitCode === 0;
      return { content: output, ok };
    }
    case 'file_change':
    case 'patch': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const summary = changes
        .map((c) => {
          if (!c || typeof c !== 'object') return '';
          const r = c as Record<string, unknown>;
          const kind = stringField(r, 'kind') ?? 'change';
          const path = stringField(r, 'path') ?? '';
          return `${kind} ${path}`.trim();
        })
        .filter(Boolean)
        .join('\n');
      const status = stringField(item, 'status');
      return { content: summary, ok: status !== 'failed' };
    }
    case 'mcp_tool_call': {
      const result =
        stringField(item, 'result') ??
        stringField(item, 'output') ??
        safeStringify(item['result'] ?? item['output']);
      const status = stringField(item, 'status');
      return { content: result, ok: status !== 'failed' };
    }
    case 'web_search':
    case 'web_fetch':
    case 'browse': {
      const result = stringField(item, 'result') ?? stringField(item, 'summary') ?? '';
      return { content: result, ok: true };
    }
    case 'todo_list':
    case 'sub_agent': {
      const status = stringField(item, 'status');
      return { content: safeStringify(item), ok: status !== 'failed' };
    }
    default: {
      const status = stringField(item, 'status');
      return { content: safeStringify(item), ok: status !== 'failed' };
    }
  }
}

function safeStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
