import { ulid } from 'ulid';
import { getDb } from './index';
import type { Repo, SafetyMode, RunnerKind } from '../../shared/types';

interface RepoRow {
  id: string;
  github_full_name: string;
  local_path: string;
  default_branch: string;
  mode: SafetyMode;
  default_runner: RunnerKind;
  connected_at: string;
  last_seen_at: string;
}

function mapRow(r: RepoRow): Repo {
  return {
    id: r.id,
    githubFullName: r.github_full_name,
    localPath: r.local_path,
    defaultBranch: r.default_branch,
    mode: r.mode,
    defaultRunner: r.default_runner,
    connectedAt: r.connected_at,
  };
}

export function listRepos(): Repo[] {
  return getDb()
    .prepare<[], RepoRow>('SELECT * FROM repos ORDER BY connected_at ASC')
    .all()
    .map(mapRow);
}

export function getRepo(id: string): Repo | null {
  const row = getDb().prepare<[string], RepoRow>('SELECT * FROM repos WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function getRepoByFullName(fullName: string): Repo | null {
  const row = getDb()
    .prepare<[string], RepoRow>('SELECT * FROM repos WHERE github_full_name = ?')
    .get(fullName);
  return row ? mapRow(row) : null;
}

export interface CreateRepoInput {
  githubFullName: string;
  localPath: string;
  defaultBranch: string;
  mode: SafetyMode;
  defaultRunner: RunnerKind;
}

export function createRepo(input: CreateRepoInput): Repo {
  const id = ulid();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO repos
         (id, github_full_name, local_path, default_branch, mode, default_runner, connected_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.githubFullName,
      input.localPath,
      input.defaultBranch,
      input.mode,
      input.defaultRunner,
      now,
      now,
    );
  const repo = getRepo(id);
  if (!repo) throw new Error('createRepo: row vanished after insert');
  return repo;
}

export function setRepoMode(id: string, mode: SafetyMode): Repo {
  getDb()
    .prepare('UPDATE repos SET mode = ?, last_seen_at = ? WHERE id = ?')
    .run(mode, new Date().toISOString(), id);
  const repo = getRepo(id);
  if (!repo) throw new Error(`setRepoMode: repo ${id} not found`);
  return repo;
}

export function deleteRepo(id: string): void {
  getDb().prepare('DELETE FROM repos WHERE id = ?').run(id);
}
