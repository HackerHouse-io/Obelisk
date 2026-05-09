import { parseFencedJson } from '../lib/parse-fenced-json';

export interface IosQaFinding {
  flow_id: string;
  status: 'failed';
  symptom: string;
  severity: 'P0' | 'P1' | 'P2';
  repro: string;
  likely_area: string;
  confidence: number;
  /**
   * Bucket for the finding. Defaults to 'functional' when unset (older
   * agent definitions). Visual findings (text cutoff, alignment, etc.)
   * pass at a lower confidence floor — see interpretResult.
   */
  category?: 'functional' | 'visual';
  evidence: {
    recording_path?: string;
    screenshots?: string[];
    device_log_excerpt?: string;
    syslog_excerpt?: string;
  };
}

export interface FlowMarkers {
  ok: string[];
  inconclusive: { flowId: string; reason: string }[];
}

export function parseIosQaFindings(stdout: string): IosQaFinding[] {
  return parseFencedJson<IosQaFinding>(
    stdout,
    'BEGIN_IOS_QA_FINDINGS',
    'END_IOS_QA_FINDINGS',
    isIosQaFinding,
  );
}

export function parseFlowMarkers(stdout: string): FlowMarkers {
  const ok: string[] = [];
  const inconclusive: { flowId: string; reason: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const okMatch = /^FLOW_OK:\s*(\S+)\s*$/.exec(line);
    if (okMatch) {
      ok.push(okMatch[1]!);
      continue;
    }
    const incMatch = /^FLOW_INCONCLUSIVE:\s*(\S+):\s*(.+)$/.exec(line);
    if (incMatch) {
      inconclusive.push({ flowId: incMatch[1]!, reason: incMatch[2]!.trim() });
    }
  }
  return { ok, inconclusive };
}

export interface IosScreenSnapshot {
  /** User-supplied id, e.g. "home", "settings-empty". */
  screenId: string;
  /** Verbatim XCUI source; may be XML or JSON depending on driver. */
  xcuiSource: string;
  /** Optional path to the screenshot the agent captured at this point. */
  screenshotPath?: string;
}

/**
 * Parse zero or more `BEGIN_IOS_SCREEN_SNAPSHOT screen_id=<id>` blocks
 * out of the agent's reasoning. The body is JSON, but to keep the
 * agent's output cheap to emit we accept either:
 *
 *   1. A JSON object with `xcui_source`, `screenshot_path` keys.
 *   2. A header line followed by the raw XCUI XML through to the
 *      block end. (Cheaper because the agent doesn't have to escape
 *      `"` and `\n` in xcui_source.)
 *
 * Returns one IosScreenSnapshot per block. Malformed blocks are
 * skipped silently — orchestrator-side defect detection is best-
 * effort and shouldn't fail a run.
 */
export function parseIosScreenSnapshots(stdout: string): IosScreenSnapshot[] {
  const re =
    /BEGIN_IOS_SCREEN_SNAPSHOT\s+screen_id=([^\s\n]+)\s*\n([\s\S]*?)\nEND_IOS_SCREEN_SNAPSHOT/g;
  const out: IosScreenSnapshot[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const screenId = m[1]!;
    const body = m[2]!.trim();
    if (!body) continue;
    let xcui: string | null = null;
    let screenshot: string | undefined;
    if (body.startsWith('{')) {
      try {
        const json = JSON.parse(body) as {
          xcui_source?: string;
          screenshot_path?: string;
        };
        if (typeof json.xcui_source === 'string') xcui = json.xcui_source;
        if (typeof json.screenshot_path === 'string') screenshot = json.screenshot_path;
      } catch {
        // fall through
      }
    } else {
      // Raw XML form. First line may be a metadata comment with
      // `screenshot=<path>`; strip it before passing the body on.
      const lines = body.split(/\r?\n/);
      const meta = /^#\s*screenshot=(\S+)/.exec(lines[0] ?? '');
      if (meta) {
        screenshot = meta[1]!;
        xcui = lines.slice(1).join('\n');
      } else {
        xcui = body;
      }
    }
    if (!xcui) continue;
    out.push({
      screenId,
      xcuiSource: xcui,
      ...(screenshot ? { screenshotPath: screenshot } : {}),
    });
  }
  return out;
}

function isIosQaFinding(v: unknown): v is IosQaFinding {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['flow_id'] !== 'string') return false;
  if (o['status'] !== 'failed') return false;
  if (typeof o['symptom'] !== 'string') return false;
  if (o['severity'] !== 'P0' && o['severity'] !== 'P1' && o['severity'] !== 'P2') return false;
  if (typeof o['repro'] !== 'string') return false;
  if (typeof o['likely_area'] !== 'string') return false;
  if (typeof o['confidence'] !== 'number') return false;
  if (o['confidence'] < 0 || o['confidence'] > 1) return false;
  if (o['category'] !== undefined && o['category'] !== 'functional' && o['category'] !== 'visual')
    return false;
  if (!o['evidence'] || typeof o['evidence'] !== 'object') return false;
  return true;
}
