import { ObeliskError } from '../../shared/errors';
import type { AgentName, Repo, TestPlan } from '../../shared/types';
import type { AssignedPlan } from '../prompt-compiler/types';
import { getPlan, listPlans } from './store';
import { serializePlan } from './parse';

/** Hint format the renderer + IPC use. */
const HINT_PREFIX = 'plan:';

export function parsePlanHint(taskId: string | undefined): string | null {
  if (!taskId || !taskId.startsWith(HINT_PREFIX)) return null;
  const id = taskId.slice(HINT_PREFIX.length).trim();
  return id || null;
}

/**
 * Resolve a plan for a QA agent run, with two acceptable inputs:
 *   - explicit `plan:<id>` taskId hint
 *   - any single existing plan that targets `agentName`
 *
 * Throws TEST_PLAN_REQUIRED if there are zero plans for this agent. Throws
 * TEST_PLAN_REQUIRED if there are 2+ candidate plans and no hint was given —
 * the renderer is expected to disambiguate via the picker before calling.
 */
export function resolvePlanForAgentRun(
  repo: Repo,
  agentName: AgentName,
  taskId: string | undefined,
): TestPlan {
  const explicitId = parsePlanHint(taskId);
  if (explicitId) {
    return getPlan(repo.localPath, explicitId);
  }
  const candidates = listPlans(repo.localPath, agentName);
  if (candidates.length === 0) {
    throw new ObeliskError(
      'TEST_PLAN_REQUIRED',
      `No test plan exists for ${agentName}.`,
      `Generate one from the Test Plans tab before running this agent.`,
    );
  }
  if (candidates.length > 1) {
    throw new ObeliskError(
      'TEST_PLAN_REQUIRED',
      `Multiple test plans exist for ${agentName}. Pick which one to run.`,
      `Use the plan picker on Home, or pass a specific plan id.`,
    );
  }
  return getPlan(repo.localPath, candidates[0]!.id);
}

/** Render a plan into the prompt-compiler's AssignedPlan shape. */
export function toAssignedPlan(plan: TestPlan): AssignedPlan {
  // Body without frontmatter, suitable for splicing into the user message.
  const body = serializePlan(plan.frontmatter, plan.blocks)
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .trimEnd();

  const caseRefs: AssignedPlan['caseRefs'] = [];
  let currentSection = '(no section)';
  for (const b of plan.blocks) {
    if (b.kind === 'section') {
      currentSection = b.title;
      continue;
    }
    caseRefs.push({ sectionTitle: currentSection, caseId: b.id, caseTitle: b.title });
  }
  return { id: plan.frontmatter.id, name: plan.frontmatter.name, body, caseRefs };
}
