import { join } from 'node:path';
import { getRepo } from '../db/repos';
import { setSetting } from '../db/settings';
import type { PlaybookFile } from '../agents/playbook-bootstrapper';
import {
  getPlaybookDraft,
  persistPlaybookFiles,
  quickRegeneratePlaybook,
} from '../agents/playbook-bootstrapper/publish';
import { deepRegeneratePlaybook } from '../agents/playbook-curator';
import { walkMarkdownFiles } from '../util/walk-markdown';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap } from '../../shared/types';

export async function handlePlaybookGet(
  payload: IpcMap['playbook:get']['req'],
): Promise<IpcMap['playbook:get']['res']> {
  const draft = getPlaybookDraft(payload.repoId);
  if (draft) {
    return {
      files: draft.files,
      draft: true,
      generatedAt: draft.generatedAt ?? null,
      framework: draft.framework ?? null,
    };
  }
  // No draft: surface whatever is on disk in the user's clone (higher modes).
  const repo = getRepo(payload.repoId);
  if (!repo) return { files: [], draft: false, generatedAt: null, framework: null };
  const disk = readQaFromDisk(repo.localPath);
  return { files: disk.files, draft: false, generatedAt: disk.generatedAt, framework: null };
}

interface DiskPlaybook {
  files: PlaybookFile[];
  generatedAt: string | null;
}

function readQaFromDisk(repoRoot: string): DiskPlaybook {
  const md = walkMarkdownFiles(join(repoRoot, 'qa'));
  let max = 0;
  const files: PlaybookFile[] = md.map((f) => {
    if (f.mtimeMs > max) max = f.mtimeMs;
    return { path: join('qa', f.relPath), contents: f.contents };
  });
  return {
    files,
    generatedAt: max > 0 ? new Date(max).toISOString() : null,
  };
}

/**
 * Save edits to the playbook.
 *
 * - Observe mode (or whenever we have a draft cached): write the new
 *   contents back into the per-repo `playbook.draft` setting so the
 *   user can keep iterating before committing anything.
 * - Higher modes: write the files directly into the user's local clone
 *   under `qa/`. The user is expected to commit the changes themselves;
 *   we never auto-commit edits made through the UI.
 */
export async function handlePlaybookSave(
  payload: IpcMap['playbook:save']['req'],
): Promise<IpcMap['playbook:save']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);

  if (repo.mode === 'observe') {
    const prev = getPlaybookDraft(repo.id);
    setSetting(`repo:${repo.id}`, 'playbook.draft', {
      generatedAt: new Date().toISOString(),
      files: payload.files,
      framework: prev?.framework ?? 'unknown',
      criticalFlows: prev?.criticalFlows ?? [],
    });
    return { ok: true };
  }

  persistPlaybookFiles(repo.localPath, payload.files);
  return { ok: true };
}

/**
 * Re-generate the QA playbook on demand.
 *
 * - `quick`: re-runs the heuristic bootstrapper (cheap, no LLM).
 *   Overwrites existing files — that's the contract of a manual regen.
 * - `deep`: spawns the repo's default CLI runner in an isolated worktree
 *   so it can read the codebase and rewrite each `qa/*.md` accurately.
 *
 * Output destination matches the existing save flow: Observe mode writes
 * to the per-repo draft store; higher modes write to the user's local clone.
 */
export async function handlePlaybookRegenerate(
  payload: IpcMap['playbook:regenerate']['req'],
): Promise<IpcMap['playbook:regenerate']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);

  if (payload.mode === 'deep') {
    const out = await deepRegeneratePlaybook(repo);
    const generatedAt = new Date().toISOString();
    if (repo.mode !== 'observe') {
      persistPlaybookFiles(repo.localPath, out.files);
    }
    setSetting(`repo:${repo.id}`, 'playbook.draft', {
      generatedAt,
      files: out.files,
      framework: out.framework,
      criticalFlows: [],
    });
    return { ok: true, generatedAt, fileCount: out.files.length, framework: out.framework };
  }

  const quick = await quickRegeneratePlaybook(repo);
  return {
    ok: true,
    generatedAt: quick.generatedAt,
    fileCount: quick.files.length,
    framework: quick.framework,
  };
}
