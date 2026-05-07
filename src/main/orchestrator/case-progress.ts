/**
 * Streaming parser for per-case progress markers emitted by QA agents.
 *
 * QA agents are instructed to print one line per case-state transition:
 *
 *   CASE_START <case_id>
 *   CASE_PASS <case_id>
 *   CASE_FAIL <case_id>
 *   CASE_INCONCLUSIVE <case_id>
 *
 * The orchestrator tees stdout into `feed(line)`; recognized markers fire
 * the `onTransition` callback so the orchestrator can write an audit row +
 * broadcast a bus event for live UI updates. Lines that don't match are
 * silently ignored — the agent can still write reasoning prose around the
 * markers.
 *
 * Robustness:
 *   - Tolerates leading/trailing whitespace.
 *   - Tolerates Markdown-bold wrapping (`**CASE_PASS abc**`).
 *   - Tolerates colon variants (`CASE_PASS: abc`).
 *   - case-insensitive marker keyword (CASE_pass, case_pass, etc.).
 *   - Strips a trailing parenthetical reason from the case id capture
 *     (`CASE_INCONCLUSIVE abc (no fixture available)`).
 *
 * Spec note: caseIds emitted in the BEGIN_FINDINGS block come from the plan
 * frontmatter via `assignedPlan.caseRefs` — they're ULIDs with a stable
 * shape (`01H...`). The parser just hands the captured id through verbatim.
 */
import type { CaseProgressState } from '../../shared/types';

export interface CaseProgressEvent {
  caseId: string;
  status: CaseProgressState;
  /** Optional reason / extra detail captured after the case id. */
  detail?: string;
}

const MARKER = /^\s*\**\s*CASE_(START|PASS|FAIL|INCONCLUSIVE)\b\s*:?\s*([^\s*]+)(.*?)\**\s*$/i;

const KEYWORD_TO_STATE: Record<string, CaseProgressState> = {
  START: 'running',
  PASS: 'passed',
  FAIL: 'failed',
  INCONCLUSIVE: 'inconclusive',
};

export function parseCaseProgressLine(line: string): CaseProgressEvent | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  const keyword = m[1]!.toUpperCase();
  const status = KEYWORD_TO_STATE[keyword];
  if (!status) return null;
  const caseId = m[2]!.trim();
  if (!caseId) return null;
  const tail = (m[3] ?? '').trim();
  // Strip surrounding parentheses if the agent wrote `(reason)`.
  const detail = tail.replace(/^\(\s*|\s*\)$/g, '').trim() || undefined;
  return detail ? { caseId, status, detail } : { caseId, status };
}

/**
 * Stateful streaming parser. Buffers partial lines from arbitrary stdout
 * chunks and fires `onTransition` for each recognized marker. Call `flush`
 * once stdout is complete to drain any unterminated trailing line.
 */
export class CaseProgressTracker {
  private buffer = '';
  constructor(private readonly onTransition: (evt: CaseProgressEvent) => void) {}

  feedChunk(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.consume(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  feedLine(line: string): void {
    this.consume(line);
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.consume(this.buffer);
      this.buffer = '';
    }
  }

  private consume(line: string): void {
    const evt = parseCaseProgressLine(line);
    if (evt) this.onTransition(evt);
  }
}
