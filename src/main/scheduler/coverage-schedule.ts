import type { CoverageSchedule } from '../../shared/types';
import { getSetting, setSetting } from '../db/settings';

/**
 * Per-repo schedule for the autonomous Coverage Agent sweep. Stored as
 * repo-scoped settings (not on the agents table — the Coverage Agent is a
 * pipeline, not a registry agent). Disabled by default: the loop is opt-in
 * per repo, matching the "minimum surprise" reliability bar. The manual
 * "Run coverage pass" button works regardless of this setting.
 */

/** Daily at 03:00 UTC — off-peak, same spirit as qa-hunter's default. */
export const DEFAULT_COVERAGE_CRON = '0 3 * * *';

const KEY_ENABLED = 'coverage.enabled';
const KEY_CRON = 'coverage.cron';

function scope(repoId: string): `repo:${string}` {
  return `repo:${repoId}`;
}

export function getCoverageSchedule(repoId: string): CoverageSchedule {
  const enabled = getSetting<boolean>(scope(repoId), KEY_ENABLED) ?? false;
  const cron = getSetting<string>(scope(repoId), KEY_CRON) ?? DEFAULT_COVERAGE_CRON;
  return { enabled, cron };
}

export function setCoverageSchedule(
  repoId: string,
  patch: { enabled?: boolean; cron?: string },
): CoverageSchedule {
  if (patch.enabled !== undefined) setSetting(scope(repoId), KEY_ENABLED, patch.enabled);
  if (patch.cron !== undefined && patch.cron.trim().length > 0) {
    setSetting(scope(repoId), KEY_CRON, patch.cron.trim());
  }
  return getCoverageSchedule(repoId);
}
