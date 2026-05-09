import { listRepos } from '../db/repos';
import {
  upsertBacklogFromGithub,
  listBacklogGhIssueNumbers,
  deleteBacklogGhIssue,
} from '../db/backlog';
import { getSetting, setSetting } from '../db/settings';
import { getGithub } from '../github/client';
import { OBELISK_LABELS } from '../publisher/labels';
import { broadcast } from '../ipc/bus';
import { appendAudit } from '../logger/audit';
import type { Repo } from '../../shared/types';

/**
 * Per-sweep dedup. If a previous sync for this repo is still running when
 * the next tick fires, skip it — the running one will finish or be retried
 * next cycle.
 */
const inFlightSync = new Set<string>();

const ETAG_KEY = 'backlog_sync_etag' as const;
const PER_PAGE = 50;

/**
 * Pull open issues from GitHub for every connected repo and upsert them
 * into the backlog. Called from the scheduler tick every ~2 minutes.
 *
 * Idempotent: re-running is safe thanks to migration 007's partial unique
 * index. Best-effort: failures (auth, network, rate limit) are logged via
 * audit and do not throw.
 */
export async function backlogSyncSweep(): Promise<void> {
  for (const repo of listRepos()) {
    if (inFlightSync.has(repo.id)) continue;
    inFlightSync.add(repo.id);
    void syncRepo(repo).finally(() => {
      inFlightSync.delete(repo.id);
    });
  }
}

/**
 * Sync one repo synchronously. Used by Run-now (`bug-fixer.selectTask`)
 * when the local backlog is empty: we'd rather pay one round-trip to
 * GitHub than tell the user "nothing to do" while real issues exist.
 *
 * Coalesces with the periodic sweep via `inFlightSync` — if a sweep is
 * already running for this repo, we await its in-flight promise instead
 * of starting a second one.
 */
const liveSyncs = new Map<string, Promise<void>>();
export async function syncBacklogForRepo(repoId: string): Promise<void> {
  const existing = liveSyncs.get(repoId);
  if (existing) {
    await existing;
    return;
  }
  const repo = listRepos().find((r) => r.id === repoId);
  if (!repo) return;

  const promise = syncRepo(repo);
  liveSyncs.set(repoId, promise);
  inFlightSync.add(repoId);
  try {
    await promise;
  } finally {
    liveSyncs.delete(repoId);
    inFlightSync.delete(repoId);
  }
}

async function syncRepo(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  const prevEtag = getSetting<string>(`repo:${repo.id}`, ETAG_KEY);

  let response: Awaited<ReturnType<typeof gh.issues.listForRepo>>;
  try {
    response = await gh.issues.listForRepo({
      owner,
      repo: name,
      state: 'open',
      per_page: PER_PAGE,
      sort: 'updated',
      direction: 'desc',
      ...(prevEtag ? { headers: { 'if-none-match': prevEtag } } : {}),
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 304) return; // unchanged since last sync
    appendAudit({
      runId: 'system',
      kind: 'backlog_sync_failed',
      payload: {
        repo: repo.githubFullName,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }

  const newEtag = response.headers['etag'] ?? response.headers['ETag'];
  if (newEtag) setSetting(`repo:${repo.id}`, ETAG_KEY, newEtag);

  let upserted = 0;
  const livePresent = new Set<number>();
  for (const issue of response.data) {
    if (issue.pull_request) continue; // GitHub returns PRs from this endpoint
    if (issue.draft) continue;
    if (issue.locked) continue;

    // We DO ingest issues that already have `obelisk:in-progress`. The
    // cross-installation guard at `selectTask` is the right place to
    // detect "sibling install is on it" — gating at sync time would
    // make those issues invisible to our backlog, including the right
    // panel of Mission Control. The in-flight lock on backlog rows
    // (claimed by our own runs) keeps periodic re-ingestion harmless.
    const labelNames = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));

    // The bug-fixer only acts on issues labeled `obelisk:fix`, the
    // feature-builder only on `obelisk:feature`. Issues without either
    // are explicit-opt-in territory and we leave them alone — the user
    // has to apply the label to a GitHub issue to enroll it.
    const kind = deriveKind(labelNames);
    if (kind === null) continue;

    // We deliberately do NOT filter by the actor allowlist here. The
    // allowlist gate lives at `selectTask` (and is overridden by the
    // manual trigger), so the backlog reflects every labelled issue
    // the user might want to act on. Filtering at sync time would mean
    // a Run-now bypass on a non-allowlisted author can't see the issue
    // at all — the bug the user reported on HackerHouse-io/WealthLab.

    upsertBacklogFromGithub({
      repoId: repo.id,
      githubIssue: issue.number,
      title: issue.title,
      kind,
      priorityLabel: derivePriority(labelNames),
    });
    livePresent.add(issue.number);
    upserted += 1;
  }

  // Reaper pass: any backlog row whose GitHub issue is no longer in our
  // live-eligible set is stale. The two ways to land here:
  //   1. Issue was closed (PR merged, manually closed, etc.) — GitHub's
  //      `state: 'open'` filter dropped it from `response.data`.
  //   2. The trigger label (`obelisk:fix` / `obelisk:feature`) was
  //      removed — `deriveKind` returned null and we skipped the
  //      upsert above.
  // Either way the row should leave the backlog so Mission Control's
  // "Next up" panel doesn't keep showing tasks the user already
  // resolved. We re-fetch each candidate via gh.issues.get to confirm
  // its state before deleting (avoids paginating-out false positives
  // on repos with >50 open obelisk-labelled issues).
  let reaped = 0;
  const known = listBacklogGhIssueNumbers(repo.id);
  for (const num of known) {
    if (livePresent.has(num)) continue;
    try {
      const detail = await gh.issues.get({ owner, repo: name, issue_number: num });
      const issue = detail.data;
      const stillLive =
        issue.state === 'open' &&
        !issue.locked &&
        deriveKind(
          (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? ''))),
        ) !== null;
      if (stillLive) continue;
      deleteBacklogGhIssue(repo.id, num);
      reaped += 1;
      appendAudit({
        runId: 'system',
        kind: 'backlog_row_reaped',
        payload: {
          repo: repo.githubFullName,
          issueNumber: num,
          reason:
            issue.state === 'closed'
              ? 'issue_closed'
              : issue.locked
                ? 'issue_locked'
                : 'trigger_label_removed',
        },
      });
    } catch (e) {
      // 404 → issue deleted on GitHub. Drop the row anyway.
      const status = (e as { status?: number }).status;
      if (status === 404) {
        deleteBacklogGhIssue(repo.id, num);
        reaped += 1;
        appendAudit({
          runId: 'system',
          kind: 'backlog_row_reaped',
          payload: {
            repo: repo.githubFullName,
            issueNumber: num,
            reason: 'issue_404',
          },
        });
      }
      // Other errors (rate limit, network) are non-fatal — try next sweep.
    }
  }

  if (upserted > 0 || reaped > 0) {
    broadcast({ type: 'backlog.changed', repoId: repo.id });
  }
}

/**
 * Map issue labels to a P0/P1/P2 priority. Recognises common variants:
 * `P0`, `p0`, `priority/p0`, `priority:p0`. Returns null when no priority
 * label is present.
 */
export function derivePriority(labels: string[]): 'P0' | 'P1' | 'P2' | null {
  for (const raw of labels) {
    const label = raw.toLowerCase();
    if (label.endsWith('p0') || label === 'p0') return 'P0';
    if (label.endsWith('p1') || label === 'p1') return 'P1';
    if (label.endsWith('p2') || label === 'p2') return 'P2';
  }
  return null;
}

/**
 * Map issue labels to the Obelisk-trigger kind, or null when neither
 * trigger label is present. The bug-fixer's mission line in
 * `agents/bug-fixer.md` is "Take one obelisk:fix issue …" — we honor
 * that contract literally so a user has explicit, label-based control
 * over which issues Obelisk acts on.
 *
 *   `obelisk:fix`     → bug-fixer
 *   `obelisk:feature` → feature-builder
 *   anything else     → null (skip)
 */
export function deriveKind(labels: string[]): 'bug' | 'feature' | null {
  let hasFix = false;
  let hasFeature = false;
  for (const raw of labels) {
    const label = raw.toLowerCase();
    if (label === OBELISK_LABELS.fix) hasFix = true;
    if (label === OBELISK_LABELS.feature) hasFeature = true;
  }
  // Both labels present is treated as a feature (the larger scope wins).
  // Surfacing this as ambiguous would block the user; defaulting to
  // feature-builder lets them downgrade by removing the label.
  if (hasFeature) return 'feature';
  if (hasFix) return 'bug';
  return null;
}
