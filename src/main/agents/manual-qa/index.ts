import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBELISK_LABELS } from '../../publisher/labels';
import { obeliskArtifactUrl } from '../../protocol/obelisk-protocol';
import {
  fetchOpenIssueTitles,
  normalizeText,
  previewTitleConflicts,
  titleConflicts,
} from '../lib/find-existing-issue';
import { listKnownFingerprintsForRepo, listOpenPreviewTitlesForRepo } from '../../db/previews';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { registerArtifactFromPath } from '../lib/register-artifact';
import { resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const manualQaHandler: AgentHandler = {
  name: 'manual-qa',
  // Multi-instance: each instance runs an explicit test plan via Playwright,
  // so multiple instances let you cover different feature paths on different
  // schedules. Per-plan single-flight (enforced in createRun by task_ref)
  // prevents two runs of the SAME plan from racing.
  multiInstance: true,
  addAnotherExplainer:
    'Adds another Manual QA instance — pair it with a different test plan and schedule.',
  skipsEvidenceGate: true,
  producesPatch: false,
  // QA findings always go to previews regardless of repo safety mode —
  // a false-positive run shouldn't be able to spam the user's GitHub.
  alwaysPreview: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // Manual QA must run against an explicit test plan — the gate is enforced
    // by resolvePlanForAgentRun, which throws TEST_PLAN_REQUIRED if none exists.
    const plan = resolvePlanForAgentRun(input.repo, 'manual-qa', input.taskId);
    const assigned = toAssignedPlan(plan);
    const ts = new Date().toISOString();
    return {
      task: {
        ref: `plan:${plan.frontmatter.id}`,
        kind: 'qa',
        summary: `Run "${plan.frontmatter.name}" against base URL`,
        context: `Run Playwright against the configured base URL and execute every test case in "${plan.frontmatter.name}". Generated at ${ts}.`,
        assignedPlan: assigned,
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const findings = parseQaFindings(input.runResult.reasoning);
    if (findings.length === 0) return [];

    const compiledRules = readNonBugs(input.repo.localPath).map(compileNonBugRule);
    const existing = await fetchOpenIssueTitles({
      repoFullName: input.repo.githubFullName,
      label: OBELISK_LABELS.qaBug,
    });
    // Open previews for this repo — same dedup boundary as qa-hunter, so a
    // recurring sweep doesn't pile copies of the same bug into Observe-mode.
    const openPreviewTitles = listOpenPreviewTitlesForRepo(input.repo.id);
    // Content-fingerprint set across ALL previews (open + dismissed +
    // published) for this repo. Dismissed entries stay in here, so a
    // "not a bug" decision survives the agent rewording the symptom on
    // a later run.
    const knownFingerprints = listKnownFingerprintsForRepo(input.repo.id);

    const out: PublishPlan[] = [];
    for (const f of findings) {
      if (f.confidence < 0.7) continue;
      if (matchesNonBug(f, compiledRules)) continue;

      const title = titleFor(f);
      const fingerprint = fingerprintForQa(f);
      if (knownFingerprints.has(fingerprint)) continue;
      if (existing.some((row) => titleConflicts(row.title, title, '[QA Bug]'))) continue;
      if (openPreviewTitles.some((t) => previewTitleConflicts(t, title))) continue;

      const refs = registerPlaywrightArtifacts(f, input.repo.localPath, input.runId);
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f, refs),
        labels: labelsFor(f),
        fingerprint,
      });
      // Within-batch dedup — see qa-hunter for rationale.
      openPreviewTitles.push(title);
      knownFingerprints.add(fingerprint);
    }
    return out;
  },
};

/**
 * Stable content fingerprint for a Manual QA finding. Hashes the
 * normalized flow + symptom + repro + likely_area so the bug's identity
 * survives Playwright reruns where the agent rephrases the symptom.
 * Mirrors qa-hunter's `fingerprintFor` so a "not a bug" dismissal in
 * either tab suppresses the same finding from either agent.
 */
export function fingerprintForQa(f: QaFinding): string {
  const parts = [
    normalizeText(f.flow),
    normalizeText(f.symptom),
    normalizeText(f.repro),
    normalizeText(f.likely_area),
  ].join('\n');
  return createHash('sha256').update(parts).digest('hex');
}

/* ---------- types + parser ---------- */

export interface QaFinding {
  flow: string;
  symptom: string;
  severity: 'P0' | 'P1' | 'P2';
  repro: string;
  likely_area: string;
  confidence: number;
  trace_path?: string;
  screenshot_path?: string;
  console_excerpt?: string;
  network_excerpt?: string;
}

export function parseQaFindings(stdout: string): QaFinding[] {
  return parseFencedJson<QaFinding>(stdout, 'BEGIN_QA_FINDINGS', 'END_QA_FINDINGS', isQaFinding);
}

function isQaFinding(v: unknown): v is QaFinding {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['flow'] === 'string' &&
    typeof o['symptom'] === 'string' &&
    (o['severity'] === 'P0' || o['severity'] === 'P1' || o['severity'] === 'P2') &&
    typeof o['repro'] === 'string' &&
    typeof o['likely_area'] === 'string' &&
    typeof o['confidence'] === 'number' &&
    o['confidence'] >= 0 &&
    o['confidence'] <= 1
  );
}

/* ---------- non-bugs filter ---------- */

export function readNonBugs(repoPath: string): string[] {
  const path = join(repoPath, 'qa', 'non-bugs.md');
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^\s*-\s+/.test(line))
      .map((line) =>
        line
          .replace(/^\s*-\s+/, '')
          .replace(/[`*_]/g, '')
          .trim(),
      )
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

interface CompiledRule {
  full: string;
  phrases: string[];
}

export function compileNonBugRule(rule: string): CompiledRule {
  const full = rule.toLowerCase();
  const phrases = full
    .split(/[—,;.]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  return { full, phrases };
}

export function matchesNonBug(finding: QaFinding, rules: CompiledRule[]): boolean {
  const haystack = `${finding.flow} ${finding.symptom}`.toLowerCase();
  for (const rule of rules) {
    if (rule.full && haystack.includes(rule.full)) return true;
    if (rule.phrases.some((p) => haystack.includes(p))) return true;
  }
  return false;
}

/* ---------- artifact persistence ---------- */

interface ArtifactRefs {
  traceArtifactId?: string;
  screenshotArtifactId?: string;
}

export function registerPlaywrightArtifacts(
  f: QaFinding,
  repoPath: string,
  runId: string,
): ArtifactRefs {
  const out: ArtifactRefs = {};
  const trace = registerArtifactFromPath({ rel: f.trace_path, repoPath, runId, kind: 'trace' });
  if (trace) out.traceArtifactId = trace;
  const shot = registerArtifactFromPath({
    rel: f.screenshot_path,
    repoPath,
    runId,
    kind: 'screenshot',
  });
  if (shot) out.screenshotArtifactId = shot;
  return out;
}

/* ---------- issue body shape ---------- */

function titleFor(f: QaFinding): string {
  return `[QA Bug] ${f.flow}: ${f.symptom}`;
}

function bodyFor(f: QaFinding, refs: ArtifactRefs): string {
  const traceLine = refs.traceArtifactId
    ? `- Playwright trace: [open in Obelisk](${obeliskArtifactUrl(refs.traceArtifactId)})`
    : '_(no trace captured)_';
  const shotLine = refs.screenshotArtifactId
    ? `- Screenshot: [open in Obelisk](${obeliskArtifactUrl(refs.screenshotArtifactId)})`
    : '';
  return [
    `## Severity`,
    f.severity,
    '',
    `## Repro`,
    f.repro,
    '',
    `## Likely area`,
    `\`${f.likely_area}\``,
    '',
    `## Repro confidence`,
    `${Math.round(f.confidence * 100)}%`,
    '',
    `## Evidence`,
    traceLine,
    shotLine,
    f.console_excerpt ? `\nConsole:\n\`\`\`\n${f.console_excerpt}\n\`\`\`` : '',
    f.network_excerpt ? `\nNetwork:\n\`\`\`\n${f.network_excerpt}\n\`\`\`` : '',
    '',
    `> Filed by Obelisk Manual QA. Reply \`/obelisk fix\` to assign Bug Fixer.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function labelsFor(f: QaFinding): string[] {
  return [OBELISK_LABELS.fix, f.severity, OBELISK_LABELS.qaBug];
}

/* dedup helpers extracted to ../lib/find-existing-issue.ts */
