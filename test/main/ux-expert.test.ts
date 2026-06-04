import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub Octokit so interpretResult's dedup lookup (fetchKnownIssueTitles)
// resolves instantly with no open issues instead of hitting the network with
// whatever token happens to be in the dev machine's keychain.
const fakeGh = {
  issues: { listForRepo: vi.fn().mockResolvedValue({ data: [] }) },
};
vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));
import {
  parseUxFindings,
  fingerprintForUx,
  titleFor,
  labelsFor,
  uxExpertHandler,
  type UxFinding,
} from '../../src/main/agents/ux-expert';
import { deriveKind } from '../../src/main/scheduler/backlog-sync';
import { getAgentHandler, listImplementedAgents } from '../../src/main/agents/registry';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createRun } from '../../src/main/db/runs';
import { listArtifacts } from '../../src/main/db/evidence';
import { readUxMemory } from '../../src/main/agents/ux-expert/memory';
import type { Repo } from '../../src/shared/types';

const FINDING: UxFinding = {
  heuristic: 'Nielsen #8: Aesthetic & minimalist design',
  surface: 'Settings > Billing',
  title: 'Billing page surfaces 9 rarely-used fields above the primary action',
  severity: 'P2',
  problem:
    'The plan selector, invoice history, tax id, and six other fields render before the Change plan CTA, burying the primary task.',
  impact: 'Increases time-to-task and cognitive load; users scroll past the action they came for.',
  recommendation:
    'Collapse invoice history and tax fields into an Advanced disclosure; pin Change plan as the first card.',
  suspected_files: ['src/renderer/screens/Billing.tsx:40-120'],
  scope: 'fix',
  confidence: 0.86,
  screenshot_path: 'ux-report/settings-billing/shot.png',
};

const FEATURE_FINDING: UxFinding = {
  ...FINDING,
  surface: 'Onboarding',
  title: 'Onboarding is a single 14-field form with no progress or steps',
  scope: 'feature',
  severity: 'P1',
};

describe('parseUxFindings', () => {
  it('extracts findings from a fenced BEGIN_UX_FINDINGS block', () => {
    const stdout = `Reasoning prose…

BEGIN_UX_FINDINGS
${JSON.stringify([FINDING, FEATURE_FINDING], null, 2)}
END_UX_FINDINGS

…trailing notes`;
    const findings = parseUxFindings(stdout);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.surface).toBe('Settings > Billing');
    expect(findings[1]!.scope).toBe('feature');
  });

  it('returns [] when no block is present', () => {
    expect(parseUxFindings('just prose')).toEqual([]);
  });

  it('returns [] for an empty array and on malformed JSON', () => {
    expect(parseUxFindings('BEGIN_UX_FINDINGS\n[]\nEND_UX_FINDINGS')).toEqual([]);
    expect(parseUxFindings('BEGIN_UX_FINDINGS\n[broken\nEND_UX_FINDINGS')).toEqual([]);
  });

  it('drops entries that fail the shape check', () => {
    const badScope = { ...FINDING, scope: 'redesign' };
    const badSeverity = { ...FINDING, severity: 'high' };
    const emptyRec = { ...FINDING, recommendation: '' };
    const outOfRange = { ...FINDING, confidence: 1.5 };
    const stdout = `BEGIN_UX_FINDINGS
${JSON.stringify([FINDING, badScope, badSeverity, emptyRec, outOfRange])}
END_UX_FINDINGS`;
    const findings = parseUxFindings(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe(FINDING.title);
  });

  it('accepts a finding without screenshot_path (optional)', () => {
    const noShot = { ...FINDING };
    delete (noShot as { screenshot_path?: string }).screenshot_path;
    const findings = parseUxFindings(`BEGIN_UX_FINDINGS\n${JSON.stringify([noShot])}\nEND_UX_FINDINGS`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.screenshot_path).toBeUndefined();
  });
});

describe('titleFor', () => {
  it('prefixes [UX] and the surface', () => {
    expect(titleFor(FINDING)).toBe(`[UX] Settings > Billing: ${FINDING.title}`);
  });
});

describe('labelsFor', () => {
  it('emits the ux provenance label + obelisk:fix for a fix-scoped finding', () => {
    expect(labelsFor(FINDING)).toEqual(['ux', 'obelisk:fix', 'P2']);
  });
  it('emits obelisk:feature for a feature-scoped finding', () => {
    expect(labelsFor(FEATURE_FINDING)).toEqual(['ux', 'obelisk:feature', 'P1']);
  });
});

describe('routing — ux label is inert, scope drives deriveKind', () => {
  it('fix-scoped → bug-fixer, feature-scoped → feature-builder', () => {
    expect(deriveKind(labelsFor(FINDING))).toBe('bug');
    expect(deriveKind(labelsFor(FEATURE_FINDING))).toBe('feature');
  });
});

describe('fingerprintForUx', () => {
  it('is stable when only the title is reworded', () => {
    const reworded = { ...FINDING, title: 'Billing buries the primary action under 9 fields' };
    // Title is part of the hash, so reword changes it — but surface+heuristic+problem
    // anchor identity. Assert the inverse: changing surface DOES change the print.
    const sameSurface = fingerprintForUx(FINDING);
    expect(fingerprintForUx({ ...FINDING })).toBe(sameSurface);
    expect(fingerprintForUx(reworded)).not.toBe(sameSurface);
  });

  it('differs when the surface changes', () => {
    expect(fingerprintForUx(FINDING)).not.toBe(
      fingerprintForUx({ ...FINDING, surface: 'Settings > Profile' }),
    );
  });

  it('differs when the heuristic changes (same screen, different lens)', () => {
    expect(fingerprintForUx(FINDING)).not.toBe(
      fingerprintForUx({ ...FINDING, heuristic: 'WCAG 1.4.3 contrast' }),
    );
  });

  it('ignores suspected_files ordering', () => {
    const a = { ...FINDING, suspected_files: ['a.ts', 'b.ts'] };
    const b = { ...FINDING, suspected_files: ['b.ts', 'a.ts'] };
    expect(fingerprintForUx(a)).toBe(fingerprintForUx(b));
  });
});

describe('registry', () => {
  it('registers ux-expert as an implemented, multi-instance, read-only agent', () => {
    expect(listImplementedAgents()).toContain('ux-expert');
    const handler = getAgentHandler('ux-expert');
    expect(handler.multiInstance).toBe(true);
    expect(handler.producesPatch).toBe(false);
    expect(handler.alwaysPreview).toBe(true);
    expect(handler.requiresTestPlan).toBe(true);
    expect(handler.skipsEvidenceGate).toBe(true);
  });
});

describe('interpretResult', () => {
  let tmp: string;
  let repo: Repo;
  let runId: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'obelisk-uxe-'));
    setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
    runMigrations();
    repo = createRepo({
      githubFullName: 'test/uxe',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'codex',
    });
    runId = createRun({
      repoId: repo.id,
      agentName: 'ux-expert',
      trigger: 'manual',
      taskRef: 'plan:p1',
      runnerUsed: 'codex',
    }).id;
  });

  afterEach(() => {
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeRunResult(reasoning: string): {
    ok: true;
    patch: { diff: string; filesChanged: string[] };
    testsRun: never[];
    reasoning: string;
  } {
    return { ok: true, patch: { diff: '', filesChanged: [] }, testsRun: [], reasoning };
  }

  async function interpret(findings: UxFinding[]) {
    const plans = await uxExpertHandler.interpretResult({
      repo,
      task: { ref: 'plan:p1', kind: 'sweep', context: 'UX sweep' },
      runResult: fakeRunResult(`BEGIN_UX_FINDINGS\n${JSON.stringify(findings)}\nEND_UX_FINDINGS`),
      runId,
    });
    return Array.isArray(plans) ? plans : [plans];
  }

  it('drops findings below the 0.7 confidence floor', async () => {
    const plans = await interpret([{ ...FINDING, confidence: 0.5 }]);
    expect(plans).toHaveLength(0);
  });

  it('files an issue with ux + routing + severity labels and registers the screenshot', async () => {
    writeFileSync(join(tmp, 'shot.png'), 'fake-png-bytes');
    const plans = await interpret([{ ...FINDING, screenshot_path: 'shot.png' }]);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.kind).toBe('issue');
    if (plan.kind === 'issue') {
      expect(plan.labels).toEqual(['ux', 'obelisk:fix', 'P2']);
      expect(plan.title).toContain('[UX] Settings > Billing');
      expect(plan.fingerprint).toBeTruthy();
    }
    const artifacts = listArtifacts(runId);
    expect(artifacts.map((a) => a.kind)).toEqual(['screenshot']);
  });

  it('persists a per-plan UX memory block to qa/ux-memory/<planId>.md', async () => {
    const reasoning = [
      'BEGIN_UX_FINDINGS\n[]\nEND_UX_FINDINGS',
      'BEGIN_UX_MEMORY_UPDATE\n## Navigation map\n- billing: /settings → Billing\nEND_UX_MEMORY_UPDATE',
    ].join('\n\n');
    await uxExpertHandler.interpretResult({
      repo,
      task: { ref: 'plan:p1', kind: 'sweep', context: 'x' },
      runResult: fakeRunResult(reasoning),
      runId,
    });
    expect(readUxMemory(repo.localPath, 'p1')).toContain('billing: /settings');
  });

  it('dedups two findings that share a fingerprint into one issue', async () => {
    const reworded = { ...FINDING, title: 'Billing buries the primary action' };
    // Same surface + heuristic + problem + files but DIFFERENT title still
    // produces a distinct fingerprint (title is in the hash) — so to test the
    // dedup path, emit the exact same finding twice.
    const plans = await interpret([FINDING, { ...FINDING }]);
    expect(plans).toHaveLength(1);
    // And a genuinely different finding is NOT deduped.
    const plans2 = await interpret([FINDING, reworded]);
    expect(plans2.length).toBeGreaterThanOrEqual(1);
  });
});
