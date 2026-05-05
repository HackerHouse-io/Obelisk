import { getSetting } from '../db/settings';
import type { Repo, RunnerKind } from '../../shared/types';

/**
 * The runner Obelisk should actually use for this repo.
 *
 * Resolution order:
 *  1. Global Settings → `app:defaultRunner` (what the user set in the
 *     Settings screen — authoritative).
 *  2. The per-repo `default_runner` column captured at connect time.
 *
 * Without #1 the Settings UI is a lie: it would only affect newly-connected
 * repos. The per-repo column is kept as a fallback (and a future hook for a
 * per-repo override UI).
 */
export function effectiveDefaultRunner(repo: Repo): RunnerKind {
  const fromSettings = getSetting<RunnerKind>('app', 'defaultRunner');
  return fromSettings ?? repo.defaultRunner;
}
