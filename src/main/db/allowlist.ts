import { getDb } from './index';

export interface AllowlistEntry {
  login: string;
  addedAt: string;
  addedBy: string;
}

interface Row {
  login: string;
  added_at: string;
  added_by: string;
}

function normalize(login: string): string {
  return login.trim().toLowerCase();
}

export function listAllowlist(repoId: string): AllowlistEntry[] {
  return getDb()
    .prepare<[string], Row>(
      'SELECT login, added_at, added_by FROM actor_allowlist WHERE repo_id = ? ORDER BY added_at ASC',
    )
    .all(repoId)
    .map((r) => ({ login: r.login, addedAt: r.added_at, addedBy: r.added_by }));
}

export function addToAllowlist(repoId: string, login: string, addedBy: string): void {
  getDb()
    .prepare(
      `INSERT INTO actor_allowlist (repo_id, login, added_at, added_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id, login) DO NOTHING`,
    )
    .run(repoId, normalize(login), new Date().toISOString(), addedBy);
}

export function removeFromAllowlist(repoId: string, login: string): void {
  getDb()
    .prepare('DELETE FROM actor_allowlist WHERE repo_id = ? AND login = ?')
    .run(repoId, normalize(login));
}

export function isAllowlisted(repoId: string, login: string): boolean {
  const row = getDb()
    .prepare<
      [string, string],
      { count: number }
    >('SELECT COUNT(*) AS count FROM actor_allowlist WHERE repo_id = ? AND login = ?')
    .get(repoId, normalize(login));
  return (row?.count ?? 0) > 0;
}
