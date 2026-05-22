import { ObeliskError } from '../../shared/errors';
import type { AgentName, FindingSeverity, Repo, TestPlan, TestPlanBlock } from '../../shared/types';
import type { AssignedPlan } from '../prompt-compiler/types';
import { getPlan, listPlans } from './store';

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

/**
 * Render a plan into the prompt-compiler's AssignedPlan shape.
 *
 * The agent-facing body uses a different surface than the on-disk markdown:
 *
 *   - Every case gets a visible slot id (`C1`, `C2`, …) inline in the header
 *     so the agent can quote it back in `CASE_PASS C1` markers without
 *     having to dig the ULID out of an HTML comment.
 *   - The full ULID is also rendered visibly (the agent uses it as the
 *     `case_id` in structured `Finding` JSON).
 *   - HTML comment anchors (`<!-- obelisk:id=… -->`) are stripped — they
 *     were invisible to some CLI surfaces, which caused the agent to
 *     hallucinate its own ULIDs and every marker landed as
 *     `case_progress_orphan`.
 *
 * The on-disk file (`qa/test-plans/<id>.md`) is unchanged; only the
 * agent-injected projection changes. Plans round-trip safely.
 */
export function toAssignedPlan(plan: TestPlan): AssignedPlan {
  const caseRefs: AssignedPlan['caseRefs'] = [];
  let currentSection = '(no section)';
  let nextSlot = 1;
  for (const b of plan.blocks) {
    if (b.kind === 'section') {
      currentSection = b.title;
      continue;
    }
    caseRefs.push({
      sectionTitle: currentSection,
      caseId: b.id,
      slotId: `C${nextSlot}`,
      caseTitle: b.title,
      expected: b.expected,
      repro: b.repro,
      severity: b.severity,
    });
    nextSlot += 1;
  }

  const body = renderAgentFacingBody(plan, caseRefs);
  return { id: plan.frontmatter.id, name: plan.frontmatter.name, body, caseRefs };
}

function renderAgentFacingBody(plan: TestPlan, refs: AssignedPlan['caseRefs']): string {
  const lines: string[] = [];
  const refByCaseId = new Map(refs.map((r) => [r.caseId, r] as const));

  for (const b of plan.blocks) {
    if (b.kind === 'section') {
      lines.push('', `## ${b.title.trim()}`, '');
      continue;
    }
    const ref = refByCaseId.get(b.id);
    if (!ref) continue; // defensive — every case block is added to refs above
    lines.push(renderCase(b, ref));
  }

  return lines.join('\n').trim();
}

function renderCase(
  block: Extract<TestPlanBlock, { kind: 'case' }>,
  ref: { slotId: string; caseId: string },
): string {
  const sev: FindingSeverity | null = block.severity;
  const title = block.title.trim() || '(untitled case)';
  const header = `### ${ref.slotId} (id: ${ref.caseId}) — ${title}${sev ? ` [severity: ${sev}]` : ''}`;
  const out: string[] = [header];
  if (block.expected && block.expected.trim()) {
    out.push(`- **Expected:** ${block.expected.trim()}`);
  }
  if (block.repro && block.repro.trim()) {
    out.push(`- **Repro:** ${block.repro.trim()}`);
  }
  out.push('');
  return out.join('\n');
}
