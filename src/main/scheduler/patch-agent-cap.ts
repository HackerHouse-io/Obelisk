import { getSetting } from '../db/settings';
import type { AgentName } from '../../shared/types';

/**
 * Default per-repo cap on concurrent runs of code-writing multi-instance
 * agents (bug-fixer, feature-builder). Overridable per repo via the
 * `repo:<id>:bug_fixer_cap` setting. Picked at 3 because it's enough to
 * overlap I/O + LLM latency while staying under typical CI parallelism +
 * GitHub create-PR secondary-rate-limit thresholds.
 */
export const PATCH_AGENT_DEFAULT_CAP = 3;

/** Names of multi-instance agents subject to the per-repo cap. */
export const PATCH_AGENT_NAMES: ReadonlySet<AgentName> = new Set<AgentName>([
  'bug-fixer',
  'feature-builder',
]);

export function isPatchAgent(name: AgentName): boolean {
  return PATCH_AGENT_NAMES.has(name);
}

export function getPatchAgentCap(repoId: string): number {
  const override = getSetting<number>(`repo:${repoId}`, 'bug_fixer_cap');
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return PATCH_AGENT_DEFAULT_CAP;
}
