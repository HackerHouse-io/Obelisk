import { parseExpression } from 'cron-parser';
import type { AgentName } from '../../shared/types';

/**
 * Built-in defaults per `PRD.md` §6.2. PR Reviewer is event-driven on
 * GitHub; the in-app scheduler approximates it with a 5-min poll
 * interval since it shares the same machinery.
 */
const DEFAULT_CRON: Record<AgentName, string> = {
  'qa-hunter': '0 2 * * *',
  'manual-qa': '0 * * * *',
  'bug-fixer': '0 */2 * * *',
  'feature-builder': '0 */6 * * *',
  'pr-reviewer': '*/5 * * * *',
};

export function defaultCronFor(agent: AgentName): string {
  return DEFAULT_CRON[agent];
}

/**
 * Compute the next fire time strictly after `basis`. The basis is the
 * timestamp of the last run (when there is one) or the repo's
 * `connected_at` (when the agent has never run for this repo).
 *
 * Returns null on a malformed cron expression — caller should treat as
 * "skip this agent until the user fixes the schedule."
 */
export function nextFireAt(cron: string, basis: Date): Date | null {
  try {
    // Always interpret cron expressions in UTC. Local-time schedules drift
    // across DST boundaries; users who want a specific local time can shift
    // the hour field manually.
    const it = parseExpression(cron, { currentDate: basis, tz: 'UTC' });
    return it.next().toDate();
  } catch {
    return null;
  }
}

export function isDue(cron: string, basis: Date, now: Date = new Date()): boolean {
  const next = nextFireAt(cron, basis);
  return next !== null && next.getTime() <= now.getTime();
}
