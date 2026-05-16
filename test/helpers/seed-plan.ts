import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentName, TestPlanScope } from '../../src/main/../shared/types';

/**
 * Drop a minimal valid test plan into a fixture repo. Used by orchestrator
 * integration tests that need to clear the TEST_PLAN_REQUIRED gate without
 * invoking the full generator + IPC stack.
 *
 * Embeds stable per-case ids via the `<!-- obelisk:id=... -->` markers
 * `parseBody` reads. This both keeps the fixture deterministic (so a test
 * can pre-compute the ids the orchestrator will assign to the agent) and
 * exercises the same id-preservation path real plans take after their
 * first save.
 */
export function seedTestPlanFile(opts: {
  repoPath: string;
  planId?: string;
  agentName: AgentName;
  scope?: TestPlanScope;
  feature?: string;
  cases?: number;
}): { planId: string; filePath: string; caseIds: string[] } {
  const planId =
    opts.planId ??
    (opts.scope === 'feature' && opts.feature
      ? `feature-${slugify(opts.feature)}`
      : 'full-app');
  const filePath = join(opts.repoPath, 'qa', 'test-plans', `${planId}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  const caseCount = opts.cases ?? 2;
  const caseIds = Array.from(
    { length: caseCount },
    (_, i) => `01H${planId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}CASE${String(i + 1).padStart(2, '0')}`,
  );
  const cases = caseIds
    .map(
      (id, idx) =>
        `- [ ] Case ${idx + 1}: do thing ${idx + 1}\n  <!-- obelisk:id=${id} -->\n  - **Expected:** outcome ${idx + 1}\n  - **Repro:** click ${idx + 1}`,
    )
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
  return { planId, filePath, caseIds };
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
