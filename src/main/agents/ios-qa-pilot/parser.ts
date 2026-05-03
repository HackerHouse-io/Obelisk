import { parseFencedJson } from '../lib/parse-fenced-json';

export interface IosQaFinding {
  flow_id: string;
  status: 'failed';
  symptom: string;
  severity: 'P0' | 'P1' | 'P2';
  repro: string;
  likely_area: string;
  confidence: number;
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
  if (!o['evidence'] || typeof o['evidence'] !== 'object') return false;
  return true;
}
