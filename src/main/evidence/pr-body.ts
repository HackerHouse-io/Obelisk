import type { EvidenceArtifact } from '../db/evidence';
import type { CheckResult } from './check';

export interface PrBodyInput {
  agentName: string;
  runId: string;
  taskRef: string;
  /** One paragraph the agent wrote about the change. */
  summary: string;
  /** Multi-line reasoning trace. */
  reasoning: string;
  evidence: CheckResult;
  /** Confidence score from the runner output, 0-1, or null if unknown. */
  confidence?: number | null;
  /** Local-app URI to open the run in Obelisk (Mission Control deep link). */
  obeliskRunUri?: string;
}

/**
 * Render the standard `## Evidence` block plus the disclosure header.
 * Every Obelisk PR body uses this exact shape — PR Reviewer cross-checks
 * the section structure (§AGENT_ARCHITECTURE.md §4.5).
 */
export function renderPrBody(input: PrBodyInput): string {
  const disclosure = renderDisclosure(input);
  const summary = `## Summary\n\n${input.summary.trim() || '(no summary provided)'}`;
  const evidence = renderEvidence(input.evidence);
  const reasoning = `## Reasoning\n\n${input.reasoning.trim() || '(no reasoning provided)'}`;

  return [disclosure, summary, evidence, reasoning].join('\n\n');
}

function renderDisclosure(input: PrBodyInput): string {
  const lines: string[] = [
    `> Authored by Obelisk (${input.agentName}) on behalf of the connected account.`,
    `> Task: ${input.taskRef}`,
  ];
  if (input.obeliskRunUri) {
    lines.push(`> Audit log: ${input.obeliskRunUri}`);
  }
  if (input.confidence != null) {
    lines.push(`> Confidence: ${Math.round(input.confidence * 100)}%`);
  }
  lines.push('>');
  lines.push('> Reply `/obelisk explain` to receive the full reasoning trace as a comment.');
  return lines.join('\n');
}

function renderEvidence(check: CheckResult): string {
  const tests = collectKinds(check, ['failing_test_diff', 'test_output', 'new_tests']);
  const screenshots = collectKinds(check, [
    'ui_screenshot',
    'ui_screenshot_if_ui_touched',
    'before_after_screenshot_if_ui_touched',
  ]);
  const logs = collectKinds(check, ['backend_log_or_curl_if_backend_touched']);

  return [
    '## Evidence',
    '',
    '### Tests',
    formatList(tests),
    '',
    '### Screenshots',
    formatList(screenshots),
    '',
    '### Logs',
    formatList(logs),
    '',
    '### Reasoning',
    'See the `## Reasoning` section below and the linked audit log.',
  ].join('\n');
}

function collectKinds(
  check: CheckResult,
  items: (keyof typeof check.presentByItem)[],
): EvidenceArtifact[] {
  const out: EvidenceArtifact[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const a of check.presentByItem[item] ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

function formatList(artifacts: EvidenceArtifact[]): string {
  if (artifacts.length === 0) return '_(none referenced for this change)_';
  return artifacts.map((a) => `- \`${a.kind}\` — ${describeArtifact(a)}`).join('\n');
}

function describeArtifact(a: EvidenceArtifact): string {
  // Prefer the in-repo mirror path if uploaded; otherwise fall back to a
  // local obelisk:// URI so reviewers running Obelisk can open it.
  const tag = a.uploadedToRepo
    ? `[in repo](.obelisk/records/...)`
    : `\`obelisk://artifact/${a.id}\``;
  return `${tag} · ${a.bytes} bytes · sha256:${a.sha256.slice(0, 12)}`;
}
