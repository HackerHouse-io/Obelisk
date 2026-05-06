import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentName, TestPlanScope } from '../../src/main/../shared/types';

/**
 * Drop a minimal valid test plan into a fixture repo. Used by orchestrator
 * integration tests that need to clear the TEST_PLAN_REQUIRED gate without
 * invoking the full generator + IPC stack.
 */
export function seedTestPlanFile(opts: {
  repoPath: string;
  planId?: string;
  agentName: AgentName;
  scope?: TestPlanScope;
  feature?: string;
  cases?: number;
}): { planId: string; filePath: string } {
  const planId =
    opts.planId ??
    (opts.scope === 'feature' && opts.feature
      ? `feature-${slugify(opts.feature)}`
      : 'full-app');
  const filePath = join(opts.repoPath, 'qa', 'test-plans', `${planId}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  const cases = Array.from({ length: opts.cases ?? 2 }, (_, i) => i + 1)
    .map((n) => `- [ ] Case ${n}: do thing ${n}\n  - **Expected:** outcome ${n}\n  - **Repro:** click ${n}`)
    .join('\n');
  const fm = [
    `id: ${planId}`,
    `name: ${opts.scope === 'feature' && opts.feature ? `${capitalize(opts.feature)} sweep` : 'Full app sweep'}`,
    `scope: ${opts.scope ?? 'whole-app'}`,
    `feature: ${opts.feature ? opts.feature : 'null'}`,
    `agentName: ${opts.agentName}`,
    `generatedAt: ${new Date().toISOString()}`,
    `generatedBy: manual`,
    `version: 1`,
  ].join('\n');
  const body = `## Smoke\n${cases}\n`;
  writeFileSync(filePath, `---\n${fm}\n---\n\n${body}\n`, 'utf8');
  return { planId, filePath };
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
