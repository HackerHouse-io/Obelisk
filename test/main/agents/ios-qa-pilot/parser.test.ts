import { describe, expect, it } from 'vitest';
import {
  parseFlowMarkers,
  parseIosQaFindings,
} from '../../../../src/main/agents/ios-qa-pilot/parser';

describe('parseIosQaFindings', () => {
  it('extracts a well-formed finding', () => {
    const stdout = `prose...

BEGIN_IOS_QA_FINDINGS
[
  {
    "flow_id": "abcd",
    "status": "failed",
    "symptom": "spinner forever",
    "severity": "P1",
    "repro": "1. ... 2. ...",
    "likely_area": "Auth/SignIn.swift",
    "confidence": 0.91,
    "evidence": {
      "recording_path": "obelisk-evidence/abcd/recording.mp4",
      "screenshots": ["obelisk-evidence/abcd/after.png"],
      "device_log_excerpt": "401",
      "syslog_excerpt": "..."
    }
  }
]
END_IOS_QA_FINDINGS`;
    const out = parseIosQaFindings(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]!.flow_id).toBe('abcd');
    expect(out[0]!.confidence).toBe(0.91);
  });

  it('returns [] for missing block', () => {
    expect(parseIosQaFindings('no block here')).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseIosQaFindings('BEGIN_IOS_QA_FINDINGS\n[bad}\nEND_IOS_QA_FINDINGS')).toEqual([]);
  });

  it('drops findings with confidence outside [0,1]', () => {
    const stdout = `BEGIN_IOS_QA_FINDINGS
[
  {"flow_id":"a","status":"failed","symptom":"s","severity":"P1","repro":"r","likely_area":"l","confidence":1.5,"evidence":{}}
]
END_IOS_QA_FINDINGS`;
    expect(parseIosQaFindings(stdout)).toEqual([]);
  });

  it('drops findings with status != failed', () => {
    const stdout = `BEGIN_IOS_QA_FINDINGS
[
  {"flow_id":"a","status":"passed","symptom":"s","severity":"P1","repro":"r","likely_area":"l","confidence":0.9,"evidence":{}}
]
END_IOS_QA_FINDINGS`;
    expect(parseIosQaFindings(stdout)).toEqual([]);
  });
});

describe('parseFlowMarkers', () => {
  it('collects FLOW_OK and FLOW_INCONCLUSIVE lines', () => {
    const stdout = `header

FLOW_OK: aaaa1111
random
FLOW_INCONCLUSIVE: bbbb2222: WDA failed to attach
FLOW_OK: cccc3333`;
    const m = parseFlowMarkers(stdout);
    expect(m.ok).toEqual(['aaaa1111', 'cccc3333']);
    expect(m.inconclusive).toEqual([
      { flowId: 'bbbb2222', reason: 'WDA failed to attach' },
    ]);
  });

  it('returns empty arrays when no markers present', () => {
    const m = parseFlowMarkers('nothing here');
    expect(m.ok).toEqual([]);
    expect(m.inconclusive).toEqual([]);
  });
});
