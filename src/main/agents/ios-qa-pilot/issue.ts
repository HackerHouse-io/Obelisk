import { OBELISK_LABELS } from '../../publisher/labels';
import { obeliskArtifactUrl } from '../../protocol/obelisk-protocol';
import { appendAudit } from '../../logger/audit';
import { commentedThisCycle } from '../../db/qa-flows';
import { findOpenIssueForFlow } from '../lib/find-existing-issue';
import { registerArtifactFromPath } from '../lib/register-artifact';
import type { PublishPlan } from '../types';
import type { IosQaFinding } from './parser';

export const ISSUE_PREFIX = '[QA iOS]';

export interface ArtifactRefs {
  recordingArtifactId?: string;
  screenshotArtifactIds: string[];
  syslogArtifactId?: string;
}

export function registerEvidenceArtifacts(opts: {
  finding: IosQaFinding;
  repoPath: string;
  runId: string;
}): ArtifactRefs {
  const refs: ArtifactRefs = { screenshotArtifactIds: [] };
  const recording = registerArtifactFromPath({
    rel: opts.finding.evidence.recording_path,
    repoPath: opts.repoPath,
    runId: opts.runId,
    kind: 'recording',
  });
  if (recording) refs.recordingArtifactId = recording;
  for (const shot of opts.finding.evidence.screenshots ?? []) {
    const id = registerArtifactFromPath({
      rel: shot,
      repoPath: opts.repoPath,
      runId: opts.runId,
      kind: 'screenshot',
    });
    if (id) refs.screenshotArtifactIds.push(id);
  }
  return refs;
}

export function titleFor(finding: IosQaFinding, flowTitle: string): string {
  return `${ISSUE_PREFIX} ${flowTitle}: ${finding.symptom}`;
}

export function bodyFor(opts: {
  finding: IosQaFinding;
  refs: ArtifactRefs;
  cycle: number;
  runId: string;
  flowTitle: string;
}): string {
  const { finding, refs, cycle, runId, flowTitle } = opts;
  const recordingLine = refs.recordingArtifactId
    ? `- Screen recording: [open in Obelisk](${obeliskArtifactUrl(refs.recordingArtifactId)})`
    : '_(no recording captured)_';
  const shotLines =
    refs.screenshotArtifactIds.length > 0
      ? refs.screenshotArtifactIds
          .map((id, i) => `- Screenshot ${i + 1}: [open in Obelisk](${obeliskArtifactUrl(id)})`)
          .join('\n')
      : '';
  return [
    `**Flow:** ${flowTitle}`,
    '',
    `## Severity`,
    finding.severity,
    '',
    `## Repro`,
    finding.repro,
    '',
    `## Likely area`,
    `\`${finding.likely_area}\``,
    '',
    `## Repro confidence`,
    `${Math.round(finding.confidence * 100)}%`,
    '',
    `## Evidence`,
    recordingLine,
    shotLines,
    finding.evidence.device_log_excerpt
      ? `\nDevice log:\n\`\`\`\n${finding.evidence.device_log_excerpt}\n\`\`\``
      : '',
    finding.evidence.syslog_excerpt
      ? `\nSyslog:\n\`\`\`\n${finding.evidence.syslog_excerpt}\n\`\`\``
      : '',
    '',
    `> Filed by Obelisk iOS QA Pilot · cycle ${cycle} · run ${runId.slice(0, 8)}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function commentBody(opts: {
  finding: IosQaFinding;
  refs: ArtifactRefs;
  cycle: number;
  runId: string;
}): string {
  const { finding, refs, cycle, runId } = opts;
  const recordingLine = refs.recordingArtifactId
    ? `Recording: [open in Obelisk](${obeliskArtifactUrl(refs.recordingArtifactId)})`
    : '_(no recording captured)_';
  return [
    `Reproduced again at ${Math.round(finding.confidence * 100)}% confidence on cycle ${cycle} (run ${runId.slice(0, 8)}).`,
    '',
    `**Symptom:** ${finding.symptom}`,
    `**Likely area:** \`${finding.likely_area}\``,
    '',
    recordingLine,
    finding.evidence.device_log_excerpt
      ? `\nDevice log:\n\`\`\`\n${finding.evidence.device_log_excerpt}\n\`\`\``
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function labelsFor(finding: IosQaFinding): string[] {
  return [OBELISK_LABELS.fix, finding.severity, OBELISK_LABELS.iosQaBug];
}

/**
 * Decide whether to file a fresh issue, comment on an existing one, or
 * noop because we already commented this cycle (R5).
 *
 * Side effect on the comment branch: writes a `qa_commented` audit row so
 * the next call this cycle returns noop.
 */
export async function buildPublishPlan(opts: {
  repoId: string;
  repoFullName: string;
  flowId: string;
  flowTitle: string;
  finding: IosQaFinding;
  refs: ArtifactRefs;
  cycle: number;
  runId: string;
}): Promise<PublishPlan> {
  const title = titleFor(opts.finding, opts.flowTitle);
  const existing = await findOpenIssueForFlow({
    repoFullName: opts.repoFullName,
    prefix: ISSUE_PREFIX,
    candidateTitle: title,
    label: OBELISK_LABELS.iosQaBug,
  });
  if (!existing) {
    return {
      kind: 'issue',
      title,
      body: bodyFor({
        finding: opts.finding,
        refs: opts.refs,
        cycle: opts.cycle,
        runId: opts.runId,
        flowTitle: opts.flowTitle,
      }),
      labels: labelsFor(opts.finding),
    };
  }

  if (commentedThisCycle({ repoId: opts.repoId, flowId: opts.flowId, cycle: opts.cycle })) {
    return { kind: 'noop', reason: 'already commented on existing issue this cycle' };
  }

  appendAudit({
    runId: opts.runId,
    kind: 'qa_commented',
    payload: {
      repo_id: opts.repoId,
      flow_id: opts.flowId,
      cycle: opts.cycle,
      issue_number: existing.number,
    },
  });

  return {
    kind: 'comment',
    issueNumber: existing.number,
    body: commentBody({
      finding: opts.finding,
      refs: opts.refs,
      cycle: opts.cycle,
      runId: opts.runId,
    }),
  };
}
