import { ObeliskError } from '../../shared/errors';
import {
  getPreviewById,
  listPreviewsForRepo,
  markPreviewDismissed,
  markPreviewPublished,
} from '../db/previews';
import { getPlaybookDraft } from '../agents/playbook-bootstrapper/publish';
import { getRepo } from '../db/repos';
import { publish } from '../publisher';
import { broadcast } from './bus';
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

export async function handlePreviewsGet(
  payload: IpcMap['previews:get']['req'],
): Promise<IpcMap['previews:get']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  return lookup.finding;
}

export async function handlePreviewsFileIssue(
  payload: IpcMap['previews:fileIssue']['req'],
): Promise<IpcMap['previews:fileIssue']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  if (lookup.finding.published) {
    throw new ObeliskError(
      'CONFLICT',
      `Already published as #${lookup.finding.published.issueNumber}`,
      'Open the existing issue from the row link.',
    );
  }
  const repo = getRepo(lookup.repoId);
  if (!repo) {
    throw new ObeliskError('REPO_NOT_FOUND', `Repo ${lookup.repoId} not found`);
  }

  const title = payload.title.trim();
  if (!title) {
    throw new ObeliskError('INVALID_INPUT', 'Issue title cannot be empty');
  }

  const result = await publish({
    repo,
    runId: lookup.finding.runId,
    agentName: lookup.finding.agentName,
    plan: {
      kind: 'issue',
      title,
      body: payload.body,
      labels: payload.labels,
    },
    manual: true,
  });

  if (result.kind !== 'issue') {
    throw new ObeliskError('INTERNAL', `Unexpected publish result kind: ${result.kind}`);
  }

  markPreviewPublished({
    sourcePreviewId: payload.previewId,
    runId: lookup.finding.runId,
    issueNumber: result.issueNumber,
    htmlUrl: result.htmlUrl,
  });
  broadcast({ type: 'previews.changed', repoId: lookup.repoId });

  return { issueNumber: result.issueNumber, htmlUrl: result.htmlUrl };
}

export async function handlePreviewsDismiss(
  payload: IpcMap['previews:dismiss']['req'],
): Promise<IpcMap['previews:dismiss']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  markPreviewDismissed({
    sourcePreviewId: payload.previewId,
    runId: lookup.finding.runId,
  });
  broadcast({ type: 'previews.changed', repoId: lookup.repoId });
  return { ok: true };
}
