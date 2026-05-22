/**
 * QA fallback synthesis.
 *
 * QA Hunter is contractually required to file a Finding for every `CASE_FAIL`
 * it emits, and to attempt a definitive verdict per case. In practice agents
 * occasionally:
 *   - mark `CASE_FAIL` but never include a Finding in `BEGIN_FINDINGS` (user
 *     screenshot Image #15: "1 Fail" with no preview to file).
 *   - mark `CASE_INCONCLUSIVE` and walk away (user screenshot Image #15:
 *     "4 Inconclusive" — nothing actionable).
 *
 * This module closes both gaps deterministically. For every case in the plan
 * that ends in `failed` or `inconclusive` state WITHOUT a corresponding
 * Finding (matched by `case_id` in the body), we synthesize a Finding from
 * the case's own metadata and tag it `synthetic: true`. The orchestrator's
 * existing preview pipeline then surfaces it in the UI like any other
 * finding — except the renderer can render an "auto" chip so the user knows
 * to review it before filing.
 *
 * The synthetic finding is intentionally minimal — it's a placeholder the
 * user fills in via the FileIssueModal follow-up refiner. It exists so the
 * user always has a row to act on; it's not a substitute for a real agent
 * finding.
 */

import { bodyFor, fingerprintFor, titleFor, type Finding } from '../agents/qa-hunter';
import { OBELISK_LABELS } from '../publisher/labels';
import type { CaseProgressState, FindingSeverity } from '../../shared/types';
import type { AssignedPlan } from '../prompt-compiler/types';
import type { PublishPlan } from '../agents/types';

export interface CaseFinalState {
  status: CaseProgressState;
  /** Last reason/detail the agent attached (e.g. on CASE_INCONCLUSIVE). */
  detail?: string;
}

export interface SynthesisInput {
  plan: AssignedPlan;
  /** Per-case final state observed by `CaseProgressTracker` during the run. */
  caseStates: Map<string, CaseFinalState>;
  /** PublishPlans already produced by the agent's `interpretResult`. */
  existingPlans: PublishPlan[];
  /**
   * Fingerprints of previews that already exist for this repo. A synthetic
   * finding whose fingerprint is in this set is skipped — without this,
   * re-running the same plan keeps adding duplicate auto-drafts every time
   * the agent fails the same case.
   */
  knownFingerprints?: ReadonlySet<string>;
}

/**
 * Produce additional `PublishPlan`s — one per failed-without-finding case
 * and one per inconclusive-without-finding case — so the user always has a
 * preview to act on. Cases that already have an issue plan whose body
 * mentions their `case_id` are skipped.
 */
export function synthesizeMissingFindings(input: SynthesisInput): PublishPlan[] {
  const coveredCaseIds = collectCoveredCaseIds(input.existingPlans);
  const known = input.knownFingerprints ?? new Set<string>();
  const out: PublishPlan[] = [];

  for (const ref of input.plan.caseRefs) {
    if (coveredCaseIds.has(ref.caseId)) continue;
    const state = input.caseStates.get(ref.caseId);
    if (!state) continue;
    if (state.status !== 'failed' && state.status !== 'inconclusive') continue;

    const finding = synthesizeFindingForCase(ref, state);
    const fingerprint = fingerprintFor(finding);
    if (known.has(fingerprint)) continue;
    const title = titleFor(finding);
    const labels = [OBELISK_LABELS.fix, finding.severity];
    out.push({
      kind: 'issue',
      title,
      body: bodyFor(finding),
      labels,
      fingerprint,
      finding: { ...finding, labels },
    });
  }

  return out;
}

function collectCoveredCaseIds(plans: PublishPlan[]): Set<string> {
  const out = new Set<string>();
  for (const p of plans) {
    if (p.kind !== 'issue') continue;
    const fromFinding = p.finding?.case_id?.trim();
    if (fromFinding) out.add(fromFinding);
    const m = /case[_-]?id\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i.exec(p.body);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}

function synthesizeFindingForCase(
  ref: AssignedPlan['caseRefs'][number],
  state: CaseFinalState,
): Finding {
  const title = titleForCase(ref, state);
  const severity = severityForCase(ref, state);
  const expected = (ref.expected ?? '').trim();
  const repro = (ref.repro ?? '').trim();
  const inconclusiveReason = state.detail?.trim();

  const description = buildDescription({
    caseTitle: ref.caseTitle,
    sectionTitle: ref.sectionTitle,
    status: state.status,
    inconclusiveReason,
  });

  return {
    title,
    severity,
    description,
    expected: expected.length > 0 ? expected : '(test plan did not specify an expected outcome)',
    actual:
      state.status === 'failed'
        ? 'Agent marked the case CASE_FAIL but did not include details. Open the run’s reasoning tab to see what the agent observed; refine this finding via the chat panel below before filing.'
        : inconclusiveReason
          ? `Agent could not verify pass/fail. Reported reason: ${inconclusiveReason}.`
          : 'Agent could not verify pass/fail. No reason was provided.',
    repro: repro.length > 0 ? repro : '1. Reproduce the steps described by the assigned test case.',
    suspected_files: [],
    suggested_test:
      '// Auto-drafted: add a regression test that exercises the case above\n' +
      '// once the underlying behaviour is confirmed.',
    case_id: ref.caseId,
    synthetic: true,
  };
}

function titleForCase(ref: AssignedPlan['caseRefs'][number], state: CaseFinalState): string {
  const base = ref.caseTitle.trim().length > 0 ? ref.caseTitle.trim() : `Case ${ref.slotId}`;
  return state.status === 'inconclusive' ? `Could not verify: ${base}` : base;
}

function severityForCase(
  ref: AssignedPlan['caseRefs'][number],
  state: CaseFinalState,
): FindingSeverity {
  if (ref.severity) return ref.severity;
  // Inconclusive cases default to P2 — they're "needs investigation" rather
  // than confirmed bugs, so they shouldn't dominate the user's P0/P1 queue.
  return state.status === 'inconclusive' ? 'P2' : 'P1';
}

function buildDescription(opts: {
  caseTitle: string;
  sectionTitle: string;
  status: CaseProgressState;
  inconclusiveReason: string | undefined;
}): string {
  const verdict =
    opts.status === 'inconclusive'
      ? 'The QA agent could not determine pass/fail for this case.'
      : 'The QA agent marked this case as failed.';
  const reasonLine = opts.inconclusiveReason
    ? ` Its stated reason: ${opts.inconclusiveReason}.`
    : '';
  const sectionLine =
    opts.sectionTitle && opts.sectionTitle !== '(no section)'
      ? ` (section: ${opts.sectionTitle})`
      : '';
  return (
    `${verdict} This finding was auto-drafted by Obelisk so you always have a row to act on — ` +
    `review it, refine via the chat panel, and file when ready.${reasonLine}\n\n` +
    `Case: ${opts.caseTitle}${sectionLine}.`
  );
}
