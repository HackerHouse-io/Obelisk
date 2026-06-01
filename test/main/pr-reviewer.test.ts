import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewOutput, enforceEvidenceVerdict } from '../../src/main/agents/pr-reviewer';
import {
  crossCheckEvidence,
  isEvidenceComplete,
} from '../../src/main/agents/pr-reviewer/evidence-cross-check';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-prr-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseReviewOutput', () => {
  it('extracts the structured PR review block', () => {
    const stdout = `Reading the diff…

BEGIN_PR_REVIEW
{
  "verdict": "REQUEST_CHANGES",
  "summary": "Looks good overall but the cookie path has a race.",
  "findings": [
    { "axis": "correctness", "severity": "P1", "where": "src/auth/session.ts:142", "note": "Race condition." }
  ],
  "verdict_block": "## Verdict\\nConfidence: 0.87",
  "confidence": 0.87
}
END_PR_REVIEW

…done.`;
    const out = parseReviewOutput(stdout);
    expect(out).not.toBeNull();
    expect(out!.verdict).toBe('REQUEST_CHANGES');
    expect(out!.findings).toHaveLength(1);
    expect(out!.confidence).toBeCloseTo(0.87);
  });

  it('returns null on missing block / malformed JSON / bad verdict', () => {
    expect(parseReviewOutput('no block')).toBeNull();
    expect(parseReviewOutput('BEGIN_PR_REVIEW\n{broken\nEND_PR_REVIEW')).toBeNull();
    const badVerdict = `BEGIN_PR_REVIEW
{
  "verdict": "MAYBE",
  "summary": "x",
  "findings": [],
  "verdict_block": "v",
  "confidence": 0.5
}
END_PR_REVIEW`;
    expect(parseReviewOutput(badVerdict)).toBeNull();
  });
});

describe('crossCheckEvidence', () => {
  it('flags PR bodies with no Evidence section', () => {
    const result = crossCheckEvidence('## Summary\nA fix.\n\n## Reasoning\nWhy.');
    expect(result.hasEvidenceSection).toBe(false);
    expect(result.missingSubheadings).toEqual(['Tests', 'Screenshots', 'Logs', 'Reasoning']);
    expect(isEvidenceComplete(result)).toBe(false);
  });

  it('flags subheadings that contain only the placeholder line', () => {
    const body = `## Summary

Fixed it.

## Evidence

### Tests

- \`failing_test_diff\` — \`obelisk://artifact/abc\`

### Screenshots

_(none referenced for this change)_

### Logs

_(none referenced for this change)_

### Reasoning

See below.

## Reasoning

Why.`;
    const result = crossCheckEvidence(body);
    expect(result.hasEvidenceSection).toBe(true);
    expect(result.missingSubheadings).toEqual([]);
    expect(result.emptySubheadings).toContain('Screenshots');
    expect(result.emptySubheadings).toContain('Logs');
    expect(isEvidenceComplete(result)).toBe(false);
  });

  it('passes when Tests + Screenshots + Logs are populated', () => {
    const body = `## Evidence

### Tests

- \`patch\` — \`obelisk://artifact/a1\`

### Screenshots

- \`screenshot\` — \`obelisk://artifact/a2\`

### Logs

- \`curl_log\` — \`obelisk://artifact/a3\`

### Reasoning

See below.`;
    const result = crossCheckEvidence(body);
    expect(isEvidenceComplete(result)).toBe(true);
  });

  it('treats "not applicable" subheadings as satisfied (kind-aware producer output)', () => {
    const body = `## Evidence

### Tests

- \`failing_test_diff\` — 2048 bytes · sha256:abc123def456 · captured in the run audit log

### Screenshots

_(not applicable — no UI changes in this PR)_

### Logs

_(not applicable — no backend changes in this PR)_

### Reasoning

See the reasoning in this PR and the linked audit log.`;
    const result = crossCheckEvidence(body);
    expect(result.hasEvidenceSection).toBe(true);
    expect(result.emptySubheadings).toEqual([]);
    expect(isEvidenceComplete(result)).toBe(true);
  });
});

describe('enforceEvidenceVerdict', () => {
  const baseReview = {
    verdict: 'APPROVE' as const,
    summary: 'LGTM.',
    findings: [],
    verdict_block: '## Verdict\nConfidence: 0.95',
    confidence: 0.95,
  };

  it('passes through verdict when evidence is complete', () => {
    const evidence = crossCheckEvidence(`## Evidence

### Tests

- \`patch\` — x

### Screenshots

- \`screenshot\` — y

### Logs

- \`log\` — z

### Reasoning

ok.`);
    const out = enforceEvidenceVerdict(baseReview, evidence);
    expect(out.event).toBe('APPROVE');
    expect(out.body).not.toContain('Evidence Pack incomplete');
  });

  it('does NOT override the verdict when the Evidence section is missing — only notes it', () => {
    const evidence = crossCheckEvidence('## Summary\nAdded thing.');
    const out = enforceEvidenceVerdict({ ...baseReview, verdict: 'APPROVE' }, evidence);
    // The reviewer verified the change itself (per the EVIDENCE GAP directive),
    // so its verdict stands — no mechanical reject.
    expect(out.event).toBe('APPROVE');
    expect(out.body).not.toContain('Evidence Pack incomplete');
    expect(out.body).toContain('no `## Evidence` section');
    expect(out.body).toContain('verified the change directly');
    expect(out.body).toContain('LGTM.'); // original review still appears below
  });

  it('does NOT override the verdict when a required subheading is empty — only notes the gap', () => {
    const evidence = crossCheckEvidence(`## Evidence

### Tests

_(none referenced for this change)_

### Screenshots

- a

### Logs

- b

### Reasoning

ok.`);
    const out = enforceEvidenceVerdict(baseReview, evidence);
    expect(out.event).toBe('APPROVE');
    expect(out.body).toContain('incomplete `## Evidence` section');
    expect(out.body).toContain('### Tests');
    expect(out.body).toContain('LGTM.');
  });
});
