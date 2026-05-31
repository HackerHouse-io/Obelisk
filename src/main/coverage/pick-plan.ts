import type { AgentName, Repo } from '../../shared/types';
import { buildCoverageReport } from './aggregate';
import { listPlans } from '../test-plans/store';

/**
 * Choose which test plan a QA agent should run when no explicit plan was
 * given (a scheduled tick, or a manual "Run now" on an instance with no
 * `defaultPlanId`). The rule, per product: pick the plan whose feature has
 * the **lowest coverage** — worst-first, so autonomous runs always attack
 * the weakest spot.
 *
 * Resolution order:
 *   1. The feature-scoped plan for `agentName` belonging to the lowest-
 *      coverage feature (ties broken by report order, then newest plan).
 *   2. A whole-app plan for `agentName` (newest), if no feature plan matched.
 *   3. The single remaining candidate from `listPlans`, if any.
 *   4. `null` when the repo has no plan for this agent at all.
 *
 * Returns the bare plan id (callers prepend the `plan:` hint prefix).
 */
export async function pickWorstCoveragePlanId(
  repo: Repo,
  agentName: AgentName,
): Promise<string | null> {
  const report = await buildCoverageReport(repo.id).catch(() => null);

  if (report) {
    // Worst feature first; within a feature, newest plan for this agent.
    const byCoverage = [...report.features].sort((a, b) => a.coveragePct - b.coveragePct);
    for (const feature of byCoverage) {
      const match = feature.planRefs
        .filter((p) => p.agentNames.includes(agentName))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (match) return match.id;
    }

    // No feature-scoped plan — fall back to the newest whole-app plan.
    const wholeApp = report.wholeAppPlans
      .filter((p) => p.agentNames.includes(agentName))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (wholeApp) return wholeApp.id;
  }

  // Last resort: any plan on disk for this agent (newest). Covers repos with
  // no coverage map, where buildCoverageReport produces no features.
  const candidates = listPlans(repo.localPath, agentName).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return candidates[0]?.id ?? null;
}
