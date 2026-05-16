import { ObeliskError } from '../../shared/errors';
import {
  getPreviewById,
  insertPreview,
  listPreviewsForRepo,
  markPreviewDismissed,
  markPreviewPublished,
  removePreviewDismissedMarker,
} from '../db/previews';
import { getPlaybookDraft } from '../agents/playbook-bootstrapper/publish';
import { getRepo } from '../db/repos';
import { getRun } from '../db/runs';
import { publish } from '../publisher';
import { OBELISK_LABELS } from '../publisher/labels';
import { syncBacklogForRepo } from '../scheduler/backlog-sync';
import { broadcast } from './bus';
import type { FindingSeverity, IpcMap } from '../../shared/types';

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

export async function handlePreviewsUndismiss(
  payload: IpcMap['previews:undismiss']['req'],
): Promise<IpcMap['previews:undismiss']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  removePreviewDismissedMarker(payload.previewId);
  broadcast({ type: 'previews.changed', repoId: lookup.repoId });
  return { ok: true };
}

/**
 * Synthesize a preview row from a failed plan case. Used by the Plan
 * tab's "File issue manually" button when the QA agent emitted
 * CASE_FAIL but did not produce a finding — the user can still file a
 * GitHub issue without re-running the agent. The synthesized row goes
 * through the same `previews:fileIssue` path as agent-produced
 * findings, so publish / dismiss / undismiss all work uniformly.
 *
 * `fingerprint` is left null so the manual draft does NOT suppress
 * future agent findings for the same case.
 */
export async function handlePreviewsCreateDraftFromCase(
  payload: IpcMap['previews:createDraftFromCase']['req'],
): Promise<IpcMap['previews:createDraftFromCase']['res']> {
  const run = getRun(payload.runId);
  if (!run) {
    throw new ObeliskError('NOT_FOUND', `Run ${payload.runId} not found`);
  }
  const caseId = payload.caseId.trim();
  if (!caseId) {
    throw new ObeliskError('INVALID_INPUT', 'caseId cannot be empty');
  }
  const caseTitle = payload.caseTitle.trim();
  if (!caseTitle) {
    throw new ObeliskError('INVALID_INPUT', 'caseTitle cannot be empty');
  }
  const severity: FindingSeverity = payload.severity ?? 'P2';
  const body = buildDraftBodyFromCase({
    caseId,
    expected: payload.expected,
    repro: payload.repro,
    failureDetail: payload.failureDetail,
    severity,
  });
  const previewId = insertPreview({
    repoId: run.repoId,
    runId: run.id,
    agentName: run.agentName,
    payload: {
      kind: 'issue',
      title: `[bug] ${caseTitle}`,
      body,
      labels: [OBELISK_LABELS.fix, `severity:${severity}`],
    },
    fingerprint: null,
  });
  const lookup = getPreviewById(previewId);
  if (!lookup) {
    throw new ObeliskError('INTERNAL', 'Failed to read back the synthesized preview');
  }
  broadcast({ type: 'previews.changed', repoId: run.repoId });
  return lookup.finding;
}

function buildDraftBodyFromCase(opts: {
  caseId: string;
  expected: string | null;
  repro: string | null;
  failureDetail: string | null;
  severity: FindingSeverity;
}): string {
  const description = opts.failureDetail?.trim()
    ? opts.failureDetail.trim()
    : '_The QA agent marked this case as failed but did not file a finding. Add details before posting._';
  const expected = opts.expected?.trim() ? opts.expected.trim() : '_(describe expected behavior)_';
  const actual = opts.failureDetail?.trim()
    ? opts.failureDetail.trim()
    : '_(describe what happened)_';
  const repro = opts.repro?.trim()
    ? opts.repro.trim()
    : '_(describe steps to reproduce — preconditions, route, role, sequence)_';
  return [
    '## Description',
    description,
    '',
    '## Expected behavior',
    expected,
    '',
    '## Actual behavior',
    actual,
    '',
    '## Steps to reproduce',
    repro,
    '',
    '## Evidence',
    '_(none captured — manual draft from the Plan tab)_',
    '',
    '## Suspected files',
    '_(none identified)_',
    '',
    '## Suggested test',
    '_(none)_',
    '',
    '## Severity',
    opts.severity,
    '',
    '> Drafted manually from a failed test plan case in Mission Control.',
    '',
    `<!-- obelisk:case_id=${opts.caseId} -->`,
  ].join('\n');
}

/**
 * Foreground sync for the Task previews card. Runs the same sweep as the
 * 2-min background pass (backlog upserts + closed-issue reaper + preview
 * close-detection), then returns the refreshed previews list so the
 * renderer gets the post-sync view in one round-trip — including any
 * findings auto-dismissed because their GitHub issue just closed.
 */
export async function handlePreviewsRefresh(
  payload: IpcMap['previews:refresh']['req'],
): Promise<IpcMap['previews:refresh']['res']> {
  await syncBacklogForRepo(payload.repoId);
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
