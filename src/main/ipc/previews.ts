import { ObeliskError } from '../../shared/errors';
import {
  getPreviewById,
  insertPreview,
  listPreviewsForRepo,
  markPreviewDismissed,
  markPreviewPublished,
  removePreviewDismissedMarker,
  updatePreviewPayload,
  type IssuePlan,
} from '../db/previews';
import {
  appendPreviewFollowup,
  getOriginalSnapshot,
  listPreviewFollowups,
  revertPreviewToOriginal,
  snapshotOriginalIfMissing,
} from '../db/preview-followups';
import { getPlaybookDraft } from '../agents/playbook-bootstrapper/publish';
import { getRepo } from '../db/repos';
import { getRun } from '../db/runs';
import { publish } from '../publisher';
import { OBELISK_LABELS } from '../publisher/labels';
import { syncBacklogForRepo } from '../scheduler/backlog-sync';
import { broadcast } from './bus';
import {
  bodyFor,
  fingerprintFor,
  parseBodyToFinding,
  stripTitlePrefix,
  titleFor,
} from '../agents/qa-hunter';
import { refineFinding } from '../agents/preview-followup/refine';
import { effectiveDefaultRunner } from '../runners/effective-default';
import { checkInstalled } from '../runners/spawn';
import { probeRunnerAuth } from '../runners/auth-probe';
import type {
  FindingSeverity,
  IpcMap,
  PreviewedFinding,
  QaFinding,
  RunnerKind,
} from '../../shared/types';

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

/* ---------- Follow-up refine chat ---------- */

interface RunnerProbeCacheEntry {
  at: number;
  res: IpcMap['previews:refineAvailable']['res'];
}
const REFINE_PROBE_TTL_MS = 60_000;
const refineProbeCache = new Map<RunnerKind, RunnerProbeCacheEntry>();
const refineInflight = new Set<number>();

export async function handlePreviewsRefineAvailable(
  payload: IpcMap['previews:refineAvailable']['req'],
): Promise<IpcMap['previews:refineAvailable']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  const repo = getRepo(lookup.repoId);
  if (!repo) {
    throw new ObeliskError('REPO_NOT_FOUND', `Repo ${lookup.repoId} not found`);
  }
  const runner = effectiveDefaultRunner(repo);
  const cached = refineProbeCache.get(runner);
  if (cached && Date.now() - cached.at < REFINE_PROBE_TTL_MS) {
    return cached.res;
  }

  const command = runner === 'codex' ? 'codex' : 'claude';
  const installed = await checkInstalled(command);
  let res: IpcMap['previews:refineAvailable']['res'];
  if (!installed.ok) {
    res = { ok: false, runner, reason: 'cli_missing' };
  } else {
    const probe = await probeRunnerAuth(runner);
    if (probe.status === 'signed_in') {
      res = { ok: true, runner };
    } else if (probe.status === 'cli_missing') {
      res = { ok: false, runner, reason: 'cli_missing' };
    } else if (probe.status === 'signed_out') {
      res = { ok: false, runner, reason: 'signed_out' };
    } else {
      res = { ok: false, runner, reason: 'unknown' };
    }
  }
  refineProbeCache.set(runner, { at: Date.now(), res });
  return res;
}

export async function handlePreviewsRefine(
  payload: IpcMap['previews:refine']['req'],
): Promise<IpcMap['previews:refine']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  if (lookup.finding.published) {
    throw new ObeliskError(
      'CONFLICT',
      'This finding has already been filed to GitHub. Refine is unavailable.',
    );
  }
  const repo = getRepo(lookup.repoId);
  if (!repo) {
    throw new ObeliskError('REPO_NOT_FOUND', `Repo ${lookup.repoId} not found`);
  }
  if (refineInflight.has(payload.previewId)) {
    throw new ObeliskError(
      'CONFLICT',
      'Another refine is already running for this finding.',
      'Wait for it to finish and try again.',
    );
  }

  // Legacy previews predate the structured `finding` payload field —
  // best-effort parse the rendered body back into a Finding so the user
  // can still refine. The LLM will rewrite whatever the parser missed.
  const baseFinding: QaFinding =
    lookup.finding.finding ??
    parseBodyToFinding({
      title: lookup.finding.title,
      body: lookup.finding.body,
      labels: lookup.finding.labels,
    });

  // Persist the user's manual title/labels onto the structured finding
  // before prompting — the LLM sees what the form sees, and the original
  // snapshot below captures the pre-refine payload so revert is precise.
  const originalPayload: IssuePlan = {
    kind: 'issue',
    title: lookup.finding.title,
    body: lookup.finding.body,
    labels: lookup.finding.labels,
    finding: baseFinding,
  };
  snapshotOriginalIfMissing({
    previewId: payload.previewId,
    payloadJson: JSON.stringify(originalPayload),
  });

  const draftTitle = stripTitlePrefix(payload.currentDraft.title.trim());
  const draftLabels = payload.currentDraft.labels.slice();
  const mergedCurrent: QaFinding = {
    ...baseFinding,
    title: draftTitle.length > 0 ? draftTitle : baseFinding.title,
    labels: draftLabels,
  };

  const userMessage = payload.userMessage.trim();
  if (!userMessage) {
    throw new ObeliskError('INVALID_INPUT', 'Follow-up message cannot be empty.');
  }
  appendPreviewFollowup({
    previewId: payload.previewId,
    role: 'user',
    content: userMessage,
  });

  const transcript = listPreviewFollowups(payload.previewId, { limit: 20 });
  const abort = new AbortController();
  refineInflight.add(payload.previewId);
  let refineResult;
  try {
    refineResult = await refineFinding({
      runner: effectiveDefaultRunner(repo),
      cwd: repo.localPath,
      current: mergedCurrent,
      transcript: transcript.slice(0, -1), // exclude the user turn we just appended
      userMessage,
      abort: abort.signal,
    });
  } finally {
    refineInflight.delete(payload.previewId);
  }

  const updated: QaFinding = refineResult.updated;
  const newTitle = titleFor(updated);
  const newBody = bodyFor(updated);
  const newFingerprint = fingerprintFor(updated);
  const labels = (
    updated.labels && updated.labels.length > 0 ? updated.labels : draftLabels
  ).slice();
  const newPayload: IssuePlan = {
    kind: 'issue',
    title: newTitle,
    body: newBody,
    labels,
    fingerprint: newFingerprint,
    finding: { ...updated, labels },
  };
  updatePreviewPayload({
    previewId: payload.previewId,
    payload: newPayload,
    fingerprint: newFingerprint,
  });
  appendPreviewFollowup({
    previewId: payload.previewId,
    role: 'assistant',
    content: refineResult.assistantReply,
  });
  broadcast({ type: 'previews.changed', repoId: lookup.repoId });
  broadcast({
    type: 'previews.followupChanged',
    previewId: payload.previewId,
    repoId: lookup.repoId,
  });

  // Build the response from what we just wrote — markers (published /
  // dismissed) and evidence don't change in a refine, so re-reading would
  // just round-trip the row we already have authoritative knowledge of.
  const refreshedFinding: PreviewedFinding = {
    ...lookup.finding,
    title: newTitle,
    body: newBody,
    labels,
    severity: updated.severity,
    finding: newPayload.finding ?? null,
  };
  return { assistantReply: refineResult.assistantReply, updated: refreshedFinding };
}

export async function handlePreviewsListFollowups(
  payload: IpcMap['previews:listFollowups']['req'],
): Promise<IpcMap['previews:listFollowups']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  return { messages: listPreviewFollowups(payload.previewId) };
}

export async function handlePreviewsRevertFollowups(
  payload: IpcMap['previews:revertFollowups']['req'],
): Promise<IpcMap['previews:revertFollowups']['res']> {
  const lookup = getPreviewById(payload.previewId);
  if (!lookup) {
    throw new ObeliskError('NOT_FOUND', `Preview ${payload.previewId} not found`);
  }
  const snapshot = getOriginalSnapshot(payload.previewId);
  if (!snapshot) {
    return { ok: true, restored: null };
  }
  let original: IssuePlan;
  try {
    original = JSON.parse(snapshot.payloadJson) as IssuePlan;
  } catch {
    throw new ObeliskError('INTERNAL', 'Original snapshot is corrupt; cannot revert.');
  }
  revertPreviewToOriginal({
    previewId: payload.previewId,
    payload: original,
    fingerprint: original.fingerprint ?? null,
  });
  broadcast({ type: 'previews.changed', repoId: lookup.repoId });
  broadcast({
    type: 'previews.followupChanged',
    previewId: payload.previewId,
    repoId: lookup.repoId,
  });
  const restored: PreviewedFinding = {
    ...lookup.finding,
    title: original.title,
    body: original.body,
    labels: original.labels ?? [],
    severity: original.finding?.severity ?? lookup.finding.severity,
    finding: original.finding ?? null,
  };
  return { ok: true, restored };
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
