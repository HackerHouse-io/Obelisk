import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getRepo } from '../db/repos';
import { setSetting } from '../db/settings';
import { getPlaybookDraft } from '../agents/playbook-bootstrapper/publish';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap } from '../../shared/types';

export async function handlePlaybookGet(
  payload: IpcMap['playbook:get']['req'],
): Promise<IpcMap['playbook:get']['res']> {
  const draft = getPlaybookDraft(payload.repoId);
  if (draft) return { files: draft.files, draft: true };
  return { files: [], draft: false };
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
    setSetting(`repo:${repo.id}`, 'playbook.draft', {
      generatedAt: new Date().toISOString(),
      files: payload.files,
      // Preserve detected metadata from the original bootstrap if any.
      framework: getPlaybookDraft(repo.id)?.framework ?? 'unknown',
      criticalFlows: getPlaybookDraft(repo.id)?.criticalFlows ?? [],
    });
    return { ok: true };
  }

  for (const f of payload.files) {
    const target = join(repo.localPath, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.contents, 'utf8');
  }
  return { ok: true };
}
