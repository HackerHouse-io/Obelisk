import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import {
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  planFilePath,
  savePlan,
} from '../../src/main/test-plans/store';
import type { TestPlanBlock } from '../../src/shared/types';

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'obelisk-plans-store-'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function blocks(): TestPlanBlock[] {
  return [
    { kind: 'section', id: ulid(), title: 'Auth' },
    {
      kind: 'case',
      id: ulid(),
      title: 'Sign up',
      expected: 'lands on /welcome',
      repro: 'submit form',
      severity: 'P0',
    },
  ];
}

describe('test-plans store', () => {
  it('createPlan writes a file under qa/test-plans/<id>.md', () => {
    const plan = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(plan.frontmatter.id).toBe('full-app');
    expect(existsSync(planFilePath(repoDir, 'full-app'))).toBe(true);
    const raw = readFileSync(planFilePath(repoDir, 'full-app'), 'utf8');
    expect(raw).toContain('## Auth');
  });

  it('createPlan disambiguates ids when a plan already exists', () => {
    createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    const second = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(second.frontmatter.id).toBe('full-app-2');
  });

  it('feature-scoped plan id is slugified', () => {
    const plan = createPlan({
      repoPath: repoDir,
      agentName: 'manual-qa',
      scope: 'feature',
      featureName: 'Sign In Flow',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(plan.frontmatter.id).toBe('feature-sign-in-flow-manual-qa');
    expect(plan.frontmatter.scope).toBe('feature');
    expect(plan.frontmatter.feature).toBe('Sign In Flow');
  });

  it('listPlans filters by agentName when plans narrow their agentNames list', () => {
    // createPlan now defaults to all QA agents; explicit `agentNames`
    // narrows so the filter has something to exclude.
    const a = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      agentNames: ['qa-hunter'],
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    const b = createPlan({
      repoPath: repoDir,
      agentName: 'manual-qa',
      agentNames: ['manual-qa'],
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(listPlans(repoDir).length).toBe(2);
    const onlyHunter = listPlans(repoDir, 'qa-hunter');
    expect(onlyHunter.map((p) => p.id)).toEqual([a.frontmatter.id]);
    expect(listPlans(repoDir, 'manual-qa').map((p) => p.id)).toEqual([b.frontmatter.id]);
  });

  it('createPlan defaults to enabling every QA agent', () => {
    // The chips on the plan editor are all selected on a brand-new plan;
    // the user shouldn't have to opt every QA agent in by hand.
    const plan = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(plan.frontmatter.agentNames).toEqual(['qa-hunter', 'manual-qa', 'ios-qa-pilot']);
    // Each QA agent's listPlans call must find the plan.
    expect(listPlans(repoDir, 'qa-hunter').map((p) => p.id)).toContain(plan.frontmatter.id);
    expect(listPlans(repoDir, 'manual-qa').map((p) => p.id)).toContain(plan.frontmatter.id);
    expect(listPlans(repoDir, 'ios-qa-pilot').map((p) => p.id)).toContain(plan.frontmatter.id);
  });

  it('listPlans returns a plan for every agent in its agentNames list', () => {
    // After createPlan + savePlan, a single plan can target multiple agents.
    // Both agents must be able to find the plan via listPlans(agent).
    const created = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    savePlan({
      repoPath: repoDir,
      planId: created.frontmatter.id,
      blocks: created.blocks,
      agentNames: ['qa-hunter', 'ios-qa-pilot'],
    });
    expect(listPlans(repoDir, 'qa-hunter').map((p) => p.id)).toContain(created.frontmatter.id);
    expect(listPlans(repoDir, 'ios-qa-pilot').map((p) => p.id)).toContain(created.frontmatter.id);
    expect(listPlans(repoDir, 'manual-qa').map((p) => p.id)).not.toContain(created.frontmatter.id);
  });

  it('savePlan bumps version + persists changes', () => {
    const initial = createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    expect(initial.frontmatter.version).toBe(1);

    const next = savePlan({
      repoPath: repoDir,
      planId: 'full-app',
      blocks: [
        ...initial.blocks,
        {
          kind: 'case',
          id: ulid(),
          title: 'Added later',
          expected: null,
          repro: null,
          severity: 'P1',
        },
      ],
      name: 'Renamed plan',
    });
    expect(next.frontmatter.version).toBe(2);
    expect(next.frontmatter.name).toBe('Renamed plan');
    expect(next.caseCount).toBe(2);

    const reread = getPlan(repoDir, 'full-app');
    expect(reread.caseCount).toBe(2);
    expect(reread.frontmatter.name).toBe('Renamed plan');
  });

  it('deletePlan removes the file', () => {
    createPlan({
      repoPath: repoDir,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      blocks: blocks(),
      generatedBy: 'manual',
    });
    deletePlan(repoDir, 'full-app');
    expect(existsSync(planFilePath(repoDir, 'full-app'))).toBe(false);
  });

  it('getPlan throws NOT_FOUND for missing ids', () => {
    expect(() => getPlan(repoDir, 'nope')).toThrow(/not found/);
  });
});
