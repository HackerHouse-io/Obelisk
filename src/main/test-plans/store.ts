import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ObeliskError } from '../../shared/errors';
import type {
  AgentName,
  TestPlan,
  TestPlanBlock,
  TestPlanFrontmatter,
  TestPlanScope,
  TestPlanSummary,
} from '../../shared/types';
import { countCases, parsePlanFile, serializePlan } from './parse';

/** Subdir under the user's repo where plans live. Mirrors the existing playbook layout. */
export const PLAN_SUBDIR = ['qa', 'test-plans'] as const;

export function plansDir(repoPath: string): string {
  return join(repoPath, ...PLAN_SUBDIR);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function planFilePath(repoPath: string, planId: string): string {
  return join(plansDir(repoPath), `${planId}.md`);
}

export function listPlans(repoPath: string, agentName?: AgentName): TestPlanSummary[] {
  const dir = plansDir(repoPath);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const out: TestPlanSummary[] = [];
  for (const f of files) {
    const full = join(dir, f);
    let plan: TestPlan;
    try {
      plan = readPlanFromFile(full);
    } catch {
      continue;
    }
    if (agentName && plan.frontmatter.agentName !== agentName) continue;
    out.push({
      id: plan.frontmatter.id,
      name: plan.frontmatter.name,
      scope: plan.frontmatter.scope,
      feature: plan.frontmatter.feature,
      agentName: plan.frontmatter.agentName,
      caseCount: plan.caseCount,
      generatedAt: plan.frontmatter.generatedAt,
      updatedAt: plan.updatedAt,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function getPlan(repoPath: string, planId: string): TestPlan {
  const path = planFilePath(repoPath, planId);
  if (!existsSync(path)) {
    throw new ObeliskError('NOT_FOUND', `test plan '${planId}' not found`);
  }
  return readPlanFromFile(path);
}

function readPlanFromFile(path: string): TestPlan {
  const raw = readFileSync(path, 'utf8');
  const parsed = parsePlanFile(raw);
  const stat = statSync(path);
  return {
    frontmatter: parsed.frontmatter,
    blocks: parsed.blocks,
    caseCount: countCases(parsed.blocks),
    filePath: path,
    updatedAt: stat.mtime.toISOString(),
  };
}

export interface SavePlanInput {
  repoPath: string;
  planId: string;
  blocks: TestPlanBlock[];
  /** Allow renaming via save without forcing a separate IPC round-trip. */
  name?: string;
}

export function savePlan(input: SavePlanInput): TestPlan {
  const path = planFilePath(input.repoPath, input.planId);
  if (!existsSync(path)) {
    throw new ObeliskError('NOT_FOUND', `test plan '${input.planId}' not found`);
  }
  const existing = readPlanFromFile(path);
  const next: TestPlanFrontmatter = {
    ...existing.frontmatter,
    name: input.name?.trim() || existing.frontmatter.name,
    version: existing.frontmatter.version + 1,
  };
  ensureDir(plansDir(input.repoPath));
  writeFileSync(path, serializePlan(next, input.blocks), 'utf8');
  return readPlanFromFile(path);
}

export interface CreatePlanInput {
  repoPath: string;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName?: string;
  blocks: TestPlanBlock[];
  generatedBy: TestPlanFrontmatter['generatedBy'];
}

export function createPlan(input: CreatePlanInput): TestPlan {
  ensureDir(plansDir(input.repoPath));
  const id = nextPlanId(input);
  const fm: TestPlanFrontmatter = {
    id,
    name: defaultPlanName(input),
    scope: input.scope,
    feature: input.scope === 'feature' ? input.featureName?.trim() ?? null : null,
    agentName: input.agentName,
    generatedAt: new Date().toISOString(),
    generatedBy: input.generatedBy,
    version: 1,
  };
  const path = planFilePath(input.repoPath, id);
  writeFileSync(path, serializePlan(fm, input.blocks), 'utf8');
  return readPlanFromFile(path);
}

export function deletePlan(repoPath: string, planId: string): void {
  const path = planFilePath(repoPath, planId);
  if (!existsSync(path)) {
    throw new ObeliskError('NOT_FOUND', `test plan '${planId}' not found`);
  }
  unlinkSync(path);
}

function defaultPlanName(input: CreatePlanInput): string {
  if (input.scope === 'feature' && input.featureName?.trim()) {
    return `${capitalize(input.featureName.trim())} sweep`;
  }
  return 'Full app sweep';
}

function nextPlanId(input: CreatePlanInput): string {
  const base =
    input.scope === 'feature' && input.featureName?.trim()
      ? `feature-${slugify(input.featureName)}`
      : 'full-app';
  // Append agent suffix when the agent isn't qa-hunter so plans don't collide.
  const suffix = input.agentName === 'qa-hunter' ? '' : `-${slugify(input.agentName)}`;
  let candidate = `${base}${suffix}`;
  let n = 2;
  while (existsSync(planFilePath(input.repoPath, candidate))) {
    candidate = `${base}${suffix}-${n}`;
    n += 1;
  }
  return candidate;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'plan';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
