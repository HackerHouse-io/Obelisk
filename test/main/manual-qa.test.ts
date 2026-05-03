import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseQaFindings,
  matchesNonBug,
  compileNonBugRule,
  readNonBugs,
  registerPlaywrightArtifacts,
} from '../../src/main/agents/manual-qa';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun } from '../../src/main/db/runs';
import { listArtifacts } from '../../src/main/db/evidence';

let tmp: string;
let runId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-mqa-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'issues',
    defaultRunner: 'codex',
  });
  const run = createRun({
    repoId: repo.id,
    agentName: 'manual-qa',
    trigger: 'manual',
    taskRef: 'qa-test',
    runnerUsed: 'codex',
  });
  runId = run.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseQaFindings', () => {
  it('extracts QA findings from a fenced block', () => {
    const stdout = `prose…

BEGIN_QA_FINDINGS
[
  {
    "flow": "Create project",
    "symptom": "Refresh loses the project",
    "severity": "P1",
    "repro": "1. Login. 2. Create. 3. Refresh.",
    "likely_area": "store/projects.ts",
    "confidence": 0.92
  }
]
END_QA_FINDINGS`;
    const findings = parseQaFindings(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe(0.92);
    expect(findings[0]!.severity).toBe('P1');
  });

  it('returns [] for missing block + malformed JSON', () => {
    expect(parseQaFindings('no block')).toEqual([]);
    expect(parseQaFindings('BEGIN_QA_FINDINGS\n[bad}\nEND_QA_FINDINGS')).toEqual([]);
  });

  it('rejects findings with confidence outside [0,1]', () => {
    const stdout = `BEGIN_QA_FINDINGS
[
  {"flow":"a","symptom":"b","severity":"P1","repro":"r","likely_area":"x","confidence":1.4}
]
END_QA_FINDINGS`;
    expect(parseQaFindings(stdout)).toEqual([]);
  });
});

describe('readNonBugs + matchesNonBug', () => {
  it('parses bullet items from qa/non-bugs.md, ignoring code marks', () => {
    mkdirSync(join(tmp, 'qa'), { recursive: true });
    writeFileSync(
      join(tmp, 'qa/non-bugs.md'),
      `# Known non-bugs\n\n- Free-tier users see an *upgrade modal* on premium routes — by design.\n- Stripe redirects to checkout.stripe.com on payment.\n`,
    );
    const rules = readNonBugs(tmp);
    expect(rules).toHaveLength(2);
    expect(rules[0]).not.toContain('*');
  });

  it('matchesNonBug detects the upgrade-modal pattern (the negative test)', () => {
    const rules = ['Free-tier users see an upgrade modal on premium routes — by design.'].map(
      compileNonBugRule,
    );
    const finding = {
      flow: 'Browse premium route',
      symptom: 'Free-tier users see an upgrade modal on premium routes',
      severity: 'P1' as const,
      repro: '...',
      likely_area: 'paywall.ts',
      confidence: 0.95,
    };
    expect(matchesNonBug(finding, rules)).toBe(true);
  });

  it('does NOT match unrelated symptoms', () => {
    const rules = ['Stripe redirects to checkout.stripe.com on payment.'].map(compileNonBugRule);
    const finding = {
      flow: 'Create project',
      symptom: 'Refresh loses project from sidebar',
      severity: 'P1' as const,
      repro: '...',
      likely_area: 'store/projects.ts',
      confidence: 0.9,
    };
    expect(matchesNonBug(finding, rules)).toBe(false);
  });
});

describe('registerPlaywrightArtifacts', () => {
  it('records trace + screenshot in evidence_artifacts when files exist', () => {
    mkdirSync(join(tmp, 'playwright-report/create'), { recursive: true });
    writeFileSync(join(tmp, 'playwright-report/create/trace.zip'), 'fake-trace-bytes');
    writeFileSync(join(tmp, 'playwright-report/create/shot.png'), 'fake-png-bytes');

    const refs = registerPlaywrightArtifacts(
      {
        flow: 'Create',
        symptom: 'x',
        severity: 'P1',
        repro: '...',
        likely_area: 'y',
        confidence: 0.9,
        trace_path: 'playwright-report/create/trace.zip',
        screenshot_path: 'playwright-report/create/shot.png',
      },
      tmp,
      runId,
    );
    expect(refs.traceArtifactId).toBeTruthy();
    expect(refs.screenshotArtifactId).toBeTruthy();

    const artifacts = listArtifacts(runId);
    const kinds = artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['screenshot', 'trace']);
    for (const a of artifacts) {
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('skips artifacts when paths do not exist', () => {
    const refs = registerPlaywrightArtifacts(
      {
        flow: 'X',
        symptom: 'y',
        severity: 'P2',
        repro: '...',
        likely_area: 'z',
        confidence: 0.8,
        trace_path: 'no/such/file.zip',
      },
      tmp,
      runId,
    );
    expect(refs.traceArtifactId).toBeUndefined();
    expect(listArtifacts(runId)).toHaveLength(0);
  });
});
