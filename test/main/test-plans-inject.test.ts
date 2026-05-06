import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createPlan } from '../../src/main/test-plans/store';
import {
  parsePlanHint,
  resolvePlanForAgentRun,
  toAssignedPlan,
} from '../../src/main/test-plans/inject';
import { generateTestPlan } from '../../src/main/test-plans/generate';
import type { Repo } from '../../src/shared/types';

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'obelisk-plans-inject-'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function fakeRepo(): Repo {
  return {
    id: 'repo-test',
    githubFullName: 'test/x',
    localPath: repoDir,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
    connectedAt: new Date().toISOString(),
  };
}

describe('parsePlanHint', () => {
  it('extracts the id from plan:<id>', () => {
    expect(parsePlanHint('plan:full-app')).toBe('full-app');
    expect(parsePlanHint('plan:feature-checkout')).toBe('feature-checkout');
  });
  it('returns null for non-plan hints', () => {
    expect(parsePlanHint('flow:abc')).toBeNull();
    expect(parsePlanHint(undefined)).toBeNull();
    expect(parsePlanHint('plan:')).toBeNull();
  });
});

describe('resolvePlanForAgentRun', () => {
  const seed = (agentName: 'qa-hunter' | 'manual-qa', id: string): void => {
    createPlan({
      repoPath: repoDir,
      agentName,
      scope: 'whole-app',
      blocks: [
        { kind: 'section', id: ulid(), title: 'Smoke' },
        {
          kind: 'case',
          id: ulid(),
          title: 'X',
          expected: null,
          repro: null,
          severity: null,
        },
      ],
      generatedBy: 'manual',
    });
    // createPlan picks the id; force a known one by renaming when needed.
    if (id !== 'full-app') {
      // For two-plan cases we leverage the id-disambiguation in createPlan,
      // which appends -2 etc.
    }
  };

  it('throws TEST_PLAN_REQUIRED when no plan exists for the agent', () => {
    expect(() => resolvePlanForAgentRun(fakeRepo(), 'qa-hunter', undefined)).toThrow(
      /No test plan exists/,
    );
  });

  it('returns the only matching plan when no hint and exactly one exists', () => {
    seed('qa-hunter', 'full-app');
    const plan = resolvePlanForAgentRun(fakeRepo(), 'qa-hunter', undefined);
    expect(plan.frontmatter.id).toBe('full-app');
  });

  it('throws TEST_PLAN_REQUIRED when 2+ plans match and no hint is given', () => {
    seed('qa-hunter', 'full-app');
    seed('qa-hunter', 'full-app-2');
    expect(() => resolvePlanForAgentRun(fakeRepo(), 'qa-hunter', undefined)).toThrow(
      /Multiple test plans/,
    );
  });

  it('honors plan:<id> hint and ignores agent filtering', () => {
    seed('qa-hunter', 'full-app');
    const plan = resolvePlanForAgentRun(fakeRepo(), 'manual-qa', 'plan:full-app');
    expect(plan.frontmatter.id).toBe('full-app');
  });
});

describe('toAssignedPlan', () => {
  it('strips frontmatter and emits per-case refs grouped by section', () => {
    const repo = fakeRepo();
    const plan = createPlan({
      repoPath: repo.localPath,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: [
        { kind: 'section', id: ulid(), title: 'Auth' },
        {
          kind: 'case',
          id: ulid(),
          title: 'Sign up',
          expected: 'ok',
          repro: 'submit',
          severity: 'P0',
        },
        { kind: 'section', id: ulid(), title: 'Checkout' },
        {
          kind: 'case',
          id: ulid(),
          title: 'Discount',
          expected: null,
          repro: null,
          severity: null,
        },
      ],
      generatedBy: 'manual',
    });
    const ap = toAssignedPlan(plan);
    expect(ap.body).toContain('## Auth');
    expect(ap.body).toContain('Sign up');
    expect(ap.body).not.toContain('---'); // frontmatter dropped
    expect(ap.caseRefs).toHaveLength(2);
    expect(ap.caseRefs[0]!.sectionTitle).toBe('Auth');
    expect(ap.caseRefs[1]!.sectionTitle).toBe('Checkout');
  });
});

describe('generateTestPlan (heuristic fallback path)', () => {
  it('falls back to the heuristic skeleton when no LLM runner is on PATH', async () => {
    // Force the runner check to fail by clearing PATH for this test.
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const plan = await generateTestPlan({
        repo: fakeRepo(),
        agentName: 'qa-hunter',
        scope: 'whole-app',
      });
      expect(plan.frontmatter.generatedBy).toBe('heuristic');
      expect(plan.caseCount).toBeGreaterThan(0);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
