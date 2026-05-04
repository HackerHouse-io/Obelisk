import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { OBELISK_LABELS } from '../../publisher/labels';
import { obeliskArtifactUrl } from '../../protocol/obelisk-protocol';
import { fetchOpenIssueTitles, titleConflicts } from '../lib/find-existing-issue';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { registerArtifactFromPath } from '../lib/register-artifact';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const manualQaHandler: AgentHandler = {
  name: 'manual-qa',
  // Singleton: today Manual QA runs every flow in qa/critical-flows.md per
  // sweep. A 2nd instance would duplicate the entire sweep, which is wasteful.
  // When per-flow scoping ships, flip to true and add a flow_claims integration.
  multiInstance: false,
  addAnotherExplainer:
    'Manual QA runs every flow in qa/critical-flows.md per sweep — only one is useful today.',
  skipsEvidenceGate: true,
  producesPatch: false,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    const flowsPath = join(input.repo.localPath, 'qa', 'critical-flows.md');
    const hasFlows = existsSync(flowsPath);
    const ts = new Date().toISOString();
    return {
      task: {
        ref: `qa-sweep:${input.repo.id}:${ulid()}`,
        kind: 'qa',
        context: hasFlows
          ? `Run Playwright against the configured base URL for every flow in qa/critical-flows.md. Generated at ${ts}.`
          : `qa/critical-flows.md not found — run universal bug rules only and emit a banner asking the user to bootstrap the playbook. Generated at ${ts}.`,
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

    const out: PublishPlan[] = [];
    for (const f of findings) {
      if (f.confidence < 0.7) continue;
      if (matchesNonBug(f, compiledRules)) continue;

      const title = titleFor(f);
      if (existing.some((row) => titleConflicts(row.title, title, '[QA Bug]'))) continue;

      const refs = registerPlaywrightArtifacts(f, input.repo.localPath, input.runId);
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f, refs),
        labels: labelsFor(f),
      });
    }
    return out;
  },
};

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
