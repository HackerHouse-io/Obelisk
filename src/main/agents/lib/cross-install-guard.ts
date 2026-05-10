import { OBELISK_LABELS } from '../../publisher/labels';
import { appendAudit } from '../../logger/audit';

export interface CrossInstallCheckArgs {
  /** Normalized lowercase label names. */
  labels: string[];
  /** Normalized lowercase assignee logins. */
  assignees: string[];
  /** Lowercased login of the user signed into this Obelisk install. */
  connectedLogin: string | null;
  /** Stable reference for audit logging, e.g. `issue#142` or `pr#42@abc123`. */
  source: string;
}

/**
 * Has another Obelisk install (or our own crashed prior run) already
 * claimed this issue/PR? Signature: `obelisk:in-progress` label present
 * AND the connected user is in the assignees — the same pair `postClaimSignal`
 * applies on a successful claim.
 *
 * When true, an audit row of kind `cross_install_skipped` is written
 * before returning so callers don't have to repeat the bookkeeping.
 */
export function isClaimedByAnotherInstall(args: CrossInstallCheckArgs): boolean {
  const { labels, assignees, connectedLogin, source } = args;
  if (!connectedLogin) return false;
  if (!labels.includes(OBELISK_LABELS.inProgress)) return false;
  if (!assignees.includes(connectedLogin)) return false;
  appendAudit({
    runId: 'system',
    kind: 'cross_install_skipped',
    payload: { source, login: connectedLogin, assignees },
  });
  return true;
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
