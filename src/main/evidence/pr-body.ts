import type { EvidenceArtifact } from '../db/evidence';
import type { CheckResult } from './check';
import type { EvidenceItem } from './rules';
import type { BugFixReport } from '../agents/bug-fixer';

const OBELISK_REPO_URL = 'https://github.com/HackerHouse-io/Obelisk';

export interface PrBodyInput {
  agentName: string;
  runId: string;
  taskRef: string;
  /**
   * Raw GitHub issue number this run is tied to, if any. Preferred over
   * parsing `taskRef`; drives the `Fixes #N.` lead line that auto-closes
   * the issue on merge.
   */
  githubNumber?: number;
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
  /**
   * Which rung of the proof ladder the agent reached for UI changes. Drives the
   * Screenshots subheading when no screenshot artifact exists (a `'ui_test'`
   * change is verified, not "not applicable").
   */
  uiProof?: 'screenshot' | 'ui_test' | 'manual';
  /**
   * Set when the Evidence Pack gate failed but the run shipped anyway (soft
   * gate / proof-ladder floor). Drives the transparency preamble at the top of
   * the PR body so reviewers and humans see the gap honestly.
   */
  softEvidenceGap?: { missing: EvidenceItem[]; manualVerification?: string };
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
  // Lead line: `Fixes #N.` — the GitHub closing keyword that auto-closes the
  // linked issue on merge. Emitted on BOTH paths (structured and fallback);
  // without it a merged PR leaves the issue open.
  const issue = resolveIssueNumber(input);
  const lead = issue !== null ? `Fixes #${issue}.` : '';

  if (input.bugFixReport) {
    return renderStructuredBody(input, input.bugFixReport, lead);
  }

  // Legacy / fallback path for agents without a structured report.
  const gapNote = input.softEvidenceGap ? renderEvidenceGapNote(input.softEvidenceGap) : '';
  const disclosure = renderDisclosure(input);
  const summary = `## Summary\n\n${input.summary.trim() || '(no summary provided)'}`;
  const reasoning = `## Reasoning\n\n${input.reasoning.trim() || '(no reasoning provided)'}`;
  const evidence = renderEvidence(input.evidence, input.uiProof);
  return [lead, gapNote, disclosure, summary, evidence, reasoning]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * Transparency preamble for a PR that shipped despite a failed Evidence Pack
 * check (soft gate / proof-ladder floor). Mirrors the PR Reviewer's evidence
 * note: it states the gap plainly and points at the author's manual
 * verification, so the PR is honest rather than a silent bypass.
 */
function renderEvidenceGapNote(gap: NonNullable<PrBodyInput['softEvidenceGap']>): string {
  const missing = gap.missing.length > 0 ? gap.missing.join(', ') : 'some Evidence Pack items';
  const verified = gap.manualVerification
    ? ` The author verified the change manually: ${gap.manualVerification.trim()}`
    : '';
  return (
    `> **Note:** this headless run could not capture every Evidence Pack item ` +
    `(missing: ${missing}).${verified} The PR ships with the gap labeled below; ` +
    `the PR Reviewer independently verifies the change rather than relying on it.`
  );
}

function renderStructuredBody(
  input: PrBodyInput,
  r: NonNullable<PrBodyInput['bugFixReport']>,
  lead: string,
): string {
  const sections: string[] = [];

  if (lead) sections.push(lead);

  if (input.softEvidenceGap) sections.push(renderEvidenceGapNote(input.softEvidenceGap));

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

  // Evidence Pack — required on every PR (PRD §7.2) and cross-checked by PR
  // Reviewer. Kind-aware: subheadings that don't apply to this change (no UI,
  // no backend) render an explicit "not applicable" line rather than a
  // missing-evidence placeholder, so a correct fix isn't flagged for proof it
  // never needed to produce.
  sections.push(renderEvidence(input.evidence, input.uiProof));

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
    `_Co-authored by [Obelisk](${OBELISK_REPO_URL})_`,
    `_Reply \`/obelisk explain\` for the full reasoning trace._`,
  ];
  if (input.obeliskRunUri) {
    parts.push(`_Audit log: ${input.obeliskRunUri}_`);
  }
  return parts.join(' · ');
}

/**
 * Resolve the GitHub issue number for the `Fixes #N.` lead. Prefers the raw
 * `githubNumber` passed by the orchestrator; falls back to parsing an
 * `issue#N` task ref. Returns null for backlog-only tasks (no issue to close).
 */
function resolveIssueNumber(input: PrBodyInput): number | null {
  if (input.githubNumber != null && Number.isFinite(input.githubNumber) && input.githubNumber > 0) {
    return input.githubNumber;
  }
  return issueNumberFromTaskRefSafe(input.taskRef);
}

function issueNumberFromTaskRefSafe(taskRef: string): number | null {
  const match = taskRef.match(/^issue#(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function renderDisclosure(input: PrBodyInput): string {
  const lines: string[] = [`> Co-authored by [Obelisk](${OBELISK_REPO_URL}).`];
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

const TEST_ITEMS: readonly EvidenceItem[] = ['failing_test_diff', 'test_output', 'new_tests'];
const SCREENSHOT_ITEMS: readonly EvidenceItem[] = [
  'ui_screenshot',
  'ui_screenshot_if_ui_touched',
  'before_after_screenshot_if_ui_touched',
];
const LOG_ITEMS: readonly EvidenceItem[] = ['backend_log_or_curl_if_backend_touched'];

function renderEvidence(check: CheckResult, uiProof?: PrBodyInput['uiProof']): string {
  return [
    '## Evidence',
    '',
    '### Tests',
    renderSubheading(check, TEST_ITEMS, 'not applicable to this change'),
    '',
    '### Screenshots',
    renderScreenshotSubheading(check, uiProof),
    '',
    '### Logs',
    renderSubheading(check, LOG_ITEMS, 'not applicable — no backend changes in this PR'),
    '',
    '### Reasoning',
    'See the reasoning in this PR and the linked audit log.',
  ].join('\n');
}

/**
 * Screenshots subheading with proof-ladder awareness. A real screenshot wins;
 * otherwise a `'ui_test'` change is "verified by a test" (not "not applicable")
 * and a `'manual'` change points at the verification note — so a UI fix that
 * climbed the ladder never reads as if it touched no UI.
 */
function renderScreenshotSubheading(check: CheckResult, uiProof?: PrBodyInput['uiProof']): string {
  const artifacts = collectKinds(check, [...SCREENSHOT_ITEMS]);
  if (artifacts.length > 0) {
    return artifacts.map((a) => `- \`${a.kind}\` — ${describeArtifact(a)}`).join('\n');
  }
  if (uiProof === 'ui_test') {
    return '_Verified by an automated UI test — see the Test plan below._';
  }
  if (uiProof === 'manual') {
    return '_Verified manually by the author — see the note above._';
  }
  const requiredButMissing = SCREENSHOT_ITEMS.some((i) => check.missing.includes(i));
  return requiredButMissing
    ? '_(none referenced for this change)_'
    : '_(not applicable — no UI changes in this PR)_';
}

/**
 * Render one Evidence subheading. Three states, keyed off `check.missing`
 * (the single source of truth — `check.ts` already encodes the kind-aware
 * `uiTouched`/`backendTouched` logic):
 *   - artifacts present  → bullet list.
 *   - required but absent → `_(none referenced for this change)_` (a genuine
 *     gap; PR Reviewer treats this as empty and verifies the change itself).
 *   - not applicable      → the `notApplicable` line (PR Reviewer treats any
 *     non-placeholder text as satisfied).
 */
function renderSubheading(
  check: CheckResult,
  items: readonly EvidenceItem[],
  notApplicable: string,
): string {
  const artifacts = collectKinds(check, [...items]);
  if (artifacts.length > 0) {
    return artifacts.map((a) => `- \`${a.kind}\` — ${describeArtifact(a)}`).join('\n');
  }
  const requiredButMissing = items.some((i) => check.missing.includes(i));
  return requiredButMissing ? '_(none referenced for this change)_' : `_(${notApplicable})_`;
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

function describeArtifact(a: EvidenceArtifact): string {
  // Keep the line clean for human reviewers on GitHub: link the in-repo mirror
  // when uploaded; otherwise just note it's in the run audit log. No raw
  // `obelisk://artifact/<id>` URIs — they only resolve inside the Obelisk app
  // and read as noise in a PR body.
  const meta = `${a.bytes} bytes · sha256:${a.sha256.slice(0, 12)}`;
  return a.uploadedToRepo
    ? `[in repo](.obelisk/records/...) · ${meta}`
    : `${meta} · captured in the run audit log`;
}
