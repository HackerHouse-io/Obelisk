import { listRepos } from '../db/repos';
import { listAllowlist } from '../db/allowlist';
import { upsertBacklogFromGithub } from '../db/backlog';
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

async function syncRepo(repo: Repo): Promise<void> {
  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) return;

  const allowlist = new Set(listAllowlist(repo.id).map((e) => e.login.toLowerCase()));
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
  for (const issue of response.data) {
    if (issue.pull_request) continue; // GitHub returns PRs from this endpoint
    if (issue.draft) continue;
    if (issue.locked) continue;

    // Skip already-claimed issues — applying the in-progress label is the
    // claim signal; if we re-ingest, the periodic sync would otherwise
    // overwrite priority/title in a way that confuses the running agent.
    const labelNames = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    if (labelNames.includes(OBELISK_LABELS.inProgress)) continue;

    const author = issue.user?.login?.toLowerCase();
    if (!author || !allowlist.has(author)) continue;

    upsertBacklogFromGithub({
      repoId: repo.id,
      githubIssue: issue.number,
      title: issue.title,
      kind: deriveKind(labelNames),
      priorityLabel: derivePriority(labelNames),
    });
    upserted += 1;
  }

  if (upserted > 0) {
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
 * Map issue labels to bug vs feature. `enhancement` and `feature` count as
 * features; everything else (including no label at all) defaults to bug.
 */
export function deriveKind(labels: string[]): 'bug' | 'feature' {
  for (const raw of labels) {
    const label = raw.toLowerCase();
    if (label === 'enhancement' || label === 'feature') return 'feature';
    if (label === 'feat' || label.endsWith('/feature') || label.endsWith(':feature')) {
      return 'feature';
    }
  }
  return 'bug';
}
