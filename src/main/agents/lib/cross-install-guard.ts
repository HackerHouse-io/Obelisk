import { OBELISK_LABELS } from '../../publisher/labels';
import { appendAudit } from '../../logger/audit';

export interface ClaimSignatureArgs {
  /** Normalized lowercase label names. */
  labels: string[];
  /** Normalized lowercase assignee logins. */
  assignees: string[];
  /** Lowercased login of the user signed into this Obelisk install. */
  connectedLogin: string | null;
}

export interface ClaimOwnershipArgs extends ClaimSignatureArgs {
  /** Stable reference for audit logging, e.g. `issue#142` or `pr#42@abc123`. */
  source: string;
  /**
   * Does THIS install have a local `runs` row for this task (any state)? The
   * SQLite DB is per-install, so a local run row is the install-identity
   * signal that disambiguates our own leftover claim from a sibling's. See
   * `classifyClaimOwnership`.
   */
  hasLocalRun: boolean;
}

/**
 * Result of disambiguating an `obelisk:in-progress` + self-assignee claim:
 *   - `unclaimed` — no claim signature; the task is free to pick up.
 *   - `self`      — the signature is ours (a local run row exists). It's a
 *                   leftover from a prior run of THIS install; proceed and let
 *                   `postClaimSignal` re-assert the idempotent label/assignee.
 *   - `foreign`   — the signature is present but no local run row exists, so
 *                   another Obelisk install (signed in as the same GitHub user
 *                   on a different machine) owns it; skip.
 */
export type ClaimOwnership = 'unclaimed' | 'self' | 'foreign';

/**
 * Pure predicate: does this issue/PR carry our claim signature —
 * `obelisk:in-progress` label present AND the connected user in the assignees,
 * the same pair `postClaimSignal` applies on a successful claim? This is
 * IDENTICAL whether the claim is ours or another install's; disambiguating the
 * two requires the local runs table (see `classifyClaimOwnership`).
 */
export function hasClaimSignature(args: ClaimSignatureArgs): boolean {
  const { labels, assignees, connectedLogin } = args;
  if (!connectedLogin) return false;
  if (!labels.includes(OBELISK_LABELS.inProgress)) return false;
  if (!assignees.includes(connectedLogin)) return false;
  return true;
}

/**
 * Classify a claim as ours, foreign, or absent. A claim signature alone can't
 * tell a sibling install's claim from our own orphaned one (both write the same
 * label + self-assignee), so we consult `hasLocalRun`: the per-install runs
 * table. With it, our own crashed/failed-run leftovers self-heal on the next
 * tick instead of locking the task out until the 24h claim-signal reaper fires.
 *
 * Writes an audit row before returning: `self_claim_recovered` for `self`,
 * `cross_install_skipped` for `foreign`, so callers don't repeat the bookkeeping.
 */
export function classifyClaimOwnership(args: ClaimOwnershipArgs): ClaimOwnership {
  const { labels, assignees, connectedLogin, source, hasLocalRun } = args;
  if (!hasClaimSignature({ labels, assignees, connectedLogin })) return 'unclaimed';
  if (hasLocalRun) {
    appendAudit({
      runId: 'system',
      kind: 'self_claim_recovered',
      payload: { source, login: connectedLogin, assignees },
    });
    return 'self';
  }
  appendAudit({
    runId: 'system',
    kind: 'cross_install_skipped',
    payload: { source, login: connectedLogin, assignees },
  });
  return 'foreign';
}

interface RawLabel {
  name?: string | null | undefined;
}
interface RawAssignee {
  login?: string | null | undefined;
}

/**
 * Normalize a GitHub `labels[]` field (which can be either string-shaped
 * or object-shaped depending on the endpoint) into a lowercase string
 * array. Matches the shape `IssueContext.labels` produces.
 */
export function normalizeGithubLabels(
  raw: ReadonlyArray<string | RawLabel | null> | null | undefined,
): string[] {
  return (raw ?? [])
    .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Normalize a GitHub `assignees[]` field into a lowercase login array.
 * Matches the shape `IssueContext.assignees` produces.
 */
export function normalizeGithubAssignees(
  raw: ReadonlyArray<RawAssignee | null> | null | undefined,
): string[] {
  return (raw ?? []).map((a) => a?.login?.toLowerCase() ?? '').filter((s) => s.length > 0);
}
