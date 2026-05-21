import type { EvidenceArtifact } from '../db/evidence';
import type { CheckResult } from './check';
import type { BugFixReport } from '../agents/bug-fixer';

export interface PrBodyInput {
  agentName: string;
  runId: string;
  taskRef: string;
  /** One paragraph the agent wrote about the change. */
  summary: string;
  /** Multi-line reasoning trace. */
  reasoning: string;
  evidence: CheckResult;
  /**
   * Bug-fixer's structured report (parsed from BEGIN_BUG_FIX_REPORT).
   * When present, the body uses the structured sections in place of a
   * raw reasoning dump.
   */
  bugFixReport?: BugFixReport | null;
  /** Confidence score from the runner output, 0-1, or null if unknown. */
  confidence?: number | null;
  /** Local-app URI to open the run in Obelisk (Mission Control deep link). */
  obeliskRunUri?: string;
}

/**
 * Build the PR body.
 *
 * **Bug-fixer path (preferred):** when the agent emitted a structured
 * `BEGIN_BUG_FIX_REPORT` block, the body reads like a senior engineer
 * wrote it — leads with `Fixes #N.`, then Summary / Root cause / Fix /
 * Test plan / Notes. The Obelisk disclosure shrinks to a small footer
 * after a horizontal rule. obelisk:// artifact URIs (which only resolve
 * inside the Obelisk app) stay out of the body — they're still in the
 * run drawer.
 *
 * **Fallback path (REPRO_FAILED, legacy agents):** the older Summary +
 * Reasoning + Evidence shape, kept so any path that doesn't emit the
 * structured block still produces a usable PR body.
 */
export function renderPrBody(input: PrBodyInput): string {
  if (input.bugFixReport) {
    return renderStructuredBody(input, input.bugFixReport);
  }

  // Legacy / fallback path for agents without a structured report.
  const disclosure = renderDisclosure(input);
  const summary = `## Summary\n\n${input.summary.trim() || '(no summary provided)'}`;
  const reasoning = `## Reasoning\n\n${input.reasoning.trim() || '(no reasoning provided)'}`;
  const evidence = renderEvidence(input.evidence);
  return [disclosure, summary, evidence, reasoning].filter((s) => s.length > 0).join('\n\n');
}

function renderStructuredBody(
  input: PrBodyInput,
  r: NonNullable<PrBodyInput['bugFixReport']>,
): string {
  const sections: string[] = [];

  // Lead line: `Fixes #N.` — auto-closes the GitHub issue on merge.
  const issue = issueNumberFromTaskRefSafe(input.taskRef);
  if (issue !== null) sections.push(`Fixes #${issue}.`);

  if (r.summary.trim()) sections.push(`## Summary\n\n${r.summary.trim()}`);
  if (r.root_cause.trim()) sections.push(`## Root cause\n\n${r.root_cause.trim()}`);

  if (r.fix.length > 0) {
    const bullets = r.fix
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
      .map((b) => `- ${b}`)
      .join('\n');
    if (bullets.length > 0) sections.push(`## Fix\n\n${bullets}`);
  }

  const testPlan = r.test_plan ? renderTestPlan(r.test_plan) : '';
  if (testPlan) sections.push(testPlan);

  if (r.notes && r.notes.length > 0) {
    const bullets = r.notes
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .map((n) => `- ${n}`)
      .join('\n');
    if (bullets.length > 0) sections.push(`## Notes\n\n${bullets}`);
  }

  // Footer: small Obelisk attribution + the audit-trace command. Lives
  // BELOW a horizontal rule so it doesn't compete with the body's main
  // content. Reviewers who care can click; everyone else ignores it.
  sections.push('---');
  sections.push(renderFooter(input));

  return sections.join('\n\n');
}

function renderTestPlan(plan: NonNullable<PrBodyInput['bugFixReport']>['test_plan']): string {
  if (!plan) return '';
  const lines: string[] = ['## Test plan'];
  const hasCases = plan.cases && plan.cases.length > 0;
  if (hasCases) {
    if (plan.new_tests_file) {
      lines.push('', `New \`${plan.new_tests_file}\` covers:`);
    } else {
      lines.push('', 'New tests cover:');
    }
    for (const c of plan.cases ?? []) {
      lines.push(`- \`${c.name}\` — ${c.asserts.trim()}`);
    }
  } else if (plan.new_tests_file) {
    lines.push('', `New tests in \`${plan.new_tests_file}\`.`);
  }
  if (plan.manual_verification) {
    if (lines.length > 1) lines.push('');
    lines.push(`Manual verification: ${plan.manual_verification}`);
  }
  if (lines.length === 1) return ''; // only the heading — skip the section
  return lines.join('\n');
}

function renderFooter(input: PrBodyInput): string {
  const parts = [
    `_Authored by Obelisk Bug Fixer_`,
    `_Reply \`/obelisk explain\` for the full reasoning trace._`,
  ];
  if (input.obeliskRunUri) {
    parts.push(`_Audit log: ${input.obeliskRunUri}_`);
  }
  return parts.join(' · ');
}

function issueNumberFromTaskRefSafe(taskRef: string): number | null {
  const match = taskRef.match(/^issue#(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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
