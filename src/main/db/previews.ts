import { getDb } from '.';
import type { AgentName } from '../../shared/types';

/**
 * A single Observe-mode "preview" — the issue an agent *would* have filed
 * if the repo were in `issues` mode or higher. Backed by `audit_log` rows
 * with `kind='preview'`; the payload is the agent's `PublishPlan`.
 */
export interface PreviewedFinding {
  /** audit_log row id — stable cursor for pagination. */
  id: number;
  runId: string;
  agentName: AgentName;
  at: string; // ISO
  /** Issue title the agent would have filed. */
  title: string;
  /** Issue body. */
  body: string;
  labels: string[];
}

interface Row {
  id: number;
  run_id: string;
  agent_name: AgentName;
  at: string;
  payload: string;
}

/**
 * Pull recent Observe-mode previews for a repo, newest first. The join
 * filters audit rows down to the runs that belong to `repoId`.
 */
export function listPreviewsForRepo(repoId: string, limit = 25): PreviewedFinding[] {
  const rows = getDb()
    .prepare<[string, number], Row>(
      `SELECT a.id, a.run_id, r.agent_name, a.at, a.payload
       FROM audit_log a
       JOIN runs r ON r.id = a.run_id
       WHERE r.repo_id = ? AND a.kind = 'preview'
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .all(repoId, limit);

  const out: PreviewedFinding[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!isIssuePlan(parsed)) continue;
    out.push({
      id: row.id,
      runId: row.run_id,
      agentName: row.agent_name,
      at: row.at,
      title: parsed.title,
      body: parsed.body,
      labels: parsed.labels ?? [],
    });
  }
  return out;
}

function isIssuePlan(
  v: unknown,
): v is { kind: 'issue'; title: string; body: string; labels?: string[] } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o['kind'] === 'issue' &&
    typeof o['title'] === 'string' &&
    typeof o['body'] === 'string' &&
    (o['labels'] === undefined ||
      (Array.isArray(o['labels']) && o['labels'].every((s) => typeof s === 'string')))
  );
}
