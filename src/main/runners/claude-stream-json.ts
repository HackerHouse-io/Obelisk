/**
 * Parse Claude Code's `--output-format stream-json --include-partial-messages`
 * output into plain text events the rest of the orchestrator can consume.
 *
 * Each line on stdout is one JSON event. The shapes we care about (others
 * are ignored — they're system/init/result metadata):
 *
 *   1. Streaming partial text — fires while the model is generating, BEFORE
 *      the assistant turn completes. This is the path that lets CASE_*
 *      markers reach Mission Control live.
 *
 *      `{ type: "stream_event",
 *         event: { type: "content_block_delta",
 *                  delta: { type: "text_delta", text: "…" } } }`
 *
 *   2. Final assistant message — fires once the assistant turn completes
 *      with the full text. Used as fallback when `--include-partial-messages`
 *      isn't honoured (older claude versions) so the run's reasoning still
 *      contains BEGIN_FINDINGS.
 *
 *      `{ type: "assistant",
 *         message: { content: [{ type: "text", text: "…" }, …] } }`
 *
 * The parser is line-based and stateful: it accumulates fragments until it
 * sees a newline, then emits the completed line. Callers feed each stdout
 * line in (already split by spawn.ts), and receive synthesised "stdout"
 * audit lines back via the onText callback.
 */

export interface ClaudeStreamParserOpts {
  /** Fired for every completed line of extracted assistant text. */
  onText: (line: string) => void;
  /**
   * Fired for non-text events (system/result/error) so callers can surface
   * them in the audit log without being lost. The string is a short
   * single-line summary, never JSON.
   */
  onMeta?: (summary: string) => void;
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

    // Path 1 — streaming text deltas.
    if (obj['type'] === 'stream_event') {
      const inner = obj['event'] as Record<string, unknown> | undefined;
      if (inner && inner['type'] === 'content_block_delta') {
        const delta = inner['delta'] as Record<string, unknown> | undefined;
        if (delta && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          this.appendDelta(delta['text']);
        }
      }
      return;
    }

    // Path 2 — final assistant message. Only contributes to the fallback
    // buffer; streaming deltas (when present) are the source of truth.
    if (obj['type'] === 'assistant') {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object') {
            const part = c as Record<string, unknown>;
            if (part['type'] === 'text' && typeof part['text'] === 'string') {
              this.finalText.push(part['text']);
            }
          }
        }
      }
      return;
    }

    // Tool-use events / system init / per-result metadata — surface a
    // short summary so the audit log isn't a wall of empty space when no
    // text has streamed yet.
    if (typeof obj['type'] === 'string') {
      const subtype = typeof obj['subtype'] === 'string' ? `:${obj['subtype'] as string}` : '';
      this.opts.onMeta?.(`[${obj['type'] as string}${subtype}]`);
    }
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
