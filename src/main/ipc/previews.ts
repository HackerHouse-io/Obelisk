import { listPreviewsForRepo } from '../db/previews';
import { getPlaybookDraft } from '../agents/playbook-bootstrapper/publish';
import type { IpcMap } from '../../shared/types';

export async function handlePreviewsList(
  payload: IpcMap['previews:list']['req'],
): Promise<IpcMap['previews:list']['res']> {
  const findings = listPreviewsForRepo(payload.repoId);
  const draft = getPlaybookDraft(payload.repoId);
  return {
    findings,
    playbookDraft: draft
      ? {
          generatedAt: draft.generatedAt,
          framework: draft.framework,
          criticalFlows: draft.criticalFlows,
          fileCount: draft.files.length,
        }
      : null,
  };
}
