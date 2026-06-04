import { createHash } from 'node:crypto';
import { OBELISK_LABELS } from '../../publisher/labels';
import { obeliskArtifactUrl } from '../../protocol/obelisk-protocol';
import { normalizeText, previewTitleConflicts } from '../lib/find-existing-issue';
import { collectKnownDedupKeys } from '../lib/dedup-keys';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { registerArtifactFromPath } from '../lib/register-artifact';
import { parsePlanHint, resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import { applyUxMemoryUpdate, parseUxMemoryUpdate, readUxMemory, uxMemoryRelPath } from './memory';
import { appendAudit } from '../../logger/audit';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

/**
 * The UI/UX Expert: drives the running app through Playwright, screenshots
 * each surface in its assigned plan, and judges the *experience* against a
 * fixed taxonomy (Nielsen's 10 heuristics, WCAG accessibility, visual
 * hierarchy, information architecture / interaction cost, and simplification).
 *
 * It is the experience-quality sibling of Manual QA: read-only, plan-gated,
 * preview-first. Each finding self-classifies a `scope` — a small `fix`
 * (routed to Bug Fixer via `obelisk:fix`) or a larger `feature` improvement
 * (routed to Feature Builder via `obelisk:feature`). The constant `ux` label
 * marks provenance across both paths.
 */
export const uxExpertHandler: AgentHandler = {
  name: 'ux-expert',
  // Multi-instance: each instance pairs with a UX surface plan, so multiple
  // instances let you audit different parts of the app on different schedules.
  // Per-plan single-flight (enforced in createRun by task_ref) prevents two
  // runs of the SAME plan from racing.
  multiInstance: true,
  addAnotherExplainer:
    'Adds another UI/UX Expert instance — pair it with a different surface plan and schedule.',
  // Doesn't write code; it files improvement issues. The Evidence Pack gate
  // (which is about PR evidence) doesn't apply.
  skipsEvidenceGate: true,
  producesPatch: false,
  requiresTestPlan: true,
  // UX findings always go to previews regardless of repo safety mode — a
  // false-positive sweep shouldn't be able to spam the user's GitHub.
  alwaysPreview: true,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // Must run against a UX surface plan — the gate is enforced by
    // resolvePlanForAgentRun, which throws TEST_PLAN_REQUIRED if none exists.
    const plan = resolvePlanForAgentRun(input.repo, 'ux-expert', input.taskId);
    const assigned = toAssignedPlan(plan);
    const ts = new Date().toISOString();

    // Inject the list of already-known UX findings so the agent self-dedups
    // upstream — far more reliable than post-hoc title similarity when the
    // same improvement gets reworded run to run. Cap at 80 titles so we don't
    // bloat the prompt on mature repos.
    const { titles: knownTitles } = await collectKnownDedupKeys(
      input.repo.id,
      input.repo.githubFullName,
      OBELISK_LABELS.ux,
    );
    const knownBlock =
      knownTitles.length === 0
        ? ''
        : [
            '',
            '## Already-known UX findings — DO NOT refile',
            '',
            'The titles below are already tracked in this repo, either as open / closed GitHub issues or as local previews (open, dismissed, or published). If your finding describes the same improvement (even with different wording), DO NOT include it in BEGIN_UX_FINDINGS. Only emit findings that are genuinely new.',
            '',
            ...knownTitles.slice(0, 80).map((t) => `- ${t}`),
          ].join('\n');

    // Per-plan memory from past runs: cached routes, click-paths, and selectors
    // for this plan's surfaces. Reading it lets the agent jump straight to each
    // screen instead of re-discovering the DOM — the main token-saver for
    // expensive Playwright sweeps. Only this plan's memory is injected.
    const memory = readUxMemory(input.repo.localPath, plan.frontmatter.id);
    const memoryBlock = memory
      ? [
          '',
          `## UI/UX memory for this plan (${uxMemoryRelPath(plan.frontmatter.id)}) — read BEFORE exploring`,
          '',
          'You wrote this on past runs of this plan. Reuse the cached routes, click-paths, and selectors to reach each surface directly instead of re-deriving them. Verify a cached path still works; if it changed, use the new one and update the memory. Then emit a refreshed BEGIN_UX_MEMORY_UPDATE block at the end.',
          '',
          memory,
        ].join('\n')
      : '';

    return {
      task: {
        ref: `plan:${plan.frontmatter.id}`,
        kind: 'sweep',
        summary: `UX sweep of ${plan.frontmatter.name} on ${input.repo.githubFullName}`,
        context:
          `Drive the live app via Playwright, screenshot each surface in "${plan.frontmatter.name}", and emit UX/UI improvement findings as JSON. Generated at ${ts}.` +
          memoryBlock +
          knownBlock,
        assignedPlan: assigned,
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    // Persist what the agent learned about this plan's surfaces (routes,
    // click-paths, selectors) so the next run reads it back and skips
    // re-discovery. Keyed by plan id parsed from the task ref. Non-fatal.
    const planId = parsePlanHint(input.task.ref);
    const memoryUpdate = parseUxMemoryUpdate(input.runResult.reasoning);
    if (planId && memoryUpdate) {
      try {
        applyUxMemoryUpdate(input.repo.localPath, planId, memoryUpdate);
        appendAudit({
          runId: input.runId,
          kind: 'memory_update',
          payload: { bytes: memoryUpdate.length, file: uxMemoryRelPath(planId) },
        });
      } catch (e) {
        appendAudit({
          runId: input.runId,
          kind: 'memory_update',
          payload: {
            error: e instanceof Error ? e.message : String(e),
            bytes: memoryUpdate.length,
          },
        });
      }
    }

    const findings = parseUxFindings(input.runResult.reasoning);
    if (findings.length === 0) return [];

    // Dedup pool unifies UX-labeled GitHub issues (open + recently-closed)
    // with all local previews (open + dismissed + published) for this repo,
    // plus titles accepted within this batch. Mirrors qa-hunter / manual-qa.
    const { titles: dedupTitles, fingerprints: dedupFingerprints } = await collectKnownDedupKeys(
      input.repo.id,
      input.repo.githubFullName,
      OBELISK_LABELS.ux,
    );

    const out: PublishPlan[] = [];
    for (const f of findings) {
      // Severity is noisy for LLM UX judgments, but a confidence floor keeps
      // shallow guesses out of the user's queue. Mirrors manual-qa's gate.
      if (f.confidence < 0.7) continue;

      const title = titleFor(f);
      const fingerprint = fingerprintForUx(f);
      // Fingerprint match wins over title-similarity: the user has already
      // seen this exact content tuple (dismissed it, published it, or it's
      // still open) and we never re-emit it even if the title was reworded.
      if (dedupFingerprints.has(fingerprint)) continue;
      if (dedupTitles.some((t) => previewTitleConflicts(t, title))) continue;

      const shotId =
        registerArtifactFromPath({
          rel: f.screenshot_path,
          repoPath: input.repo.localPath,
          runId: input.runId,
          kind: 'screenshot',
        }) ?? undefined;

      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f, shotId),
        labels: labelsFor(f),
        fingerprint,
      });
      dedupTitles.push(title);
      dedupFingerprints.add(fingerprint);
    }
    return out;
  },
};

/* ---------- types + parser ---------- */

export interface UxFinding {
  /** Taxonomy tag, e.g. "Nielsen #8: Aesthetic & minimalist" or "WCAG 1.4.3 contrast". */
  heuristic: string;
  /** Screen / route the finding is about, e.g. "Settings > Billing". */
  surface: string;
  /** One-line improvement headline. */
  title: string;
  /** P0 (blocks the task / a11y violation) · P1 (significant friction) · P2 (polish). */
  severity: 'P0' | 'P1' | 'P2';
  /** What's wrong / confusing / over-complex. */
  problem: string;
  /** Why it hurts the user (cognitive load, drop-off, exclusion). */
  impact: string;
  /** Concrete fix / how to simplify — never vague. */
  recommendation: string;
  /** File paths (with line numbers in-string when known). */
  suspected_files: string[];
  /** Routing: small localized fix vs larger improvement. */
  scope: 'fix' | 'feature';
  /** Self-reported confidence in [0,1]; below 0.7 is dropped. */
  confidence: number;
  /** Relative-to-worktree path of the captured surface screenshot. */
  screenshot_path?: string;
}

export function parseUxFindings(stdout: string): UxFinding[] {
  return parseFencedJson<UxFinding>(stdout, 'BEGIN_UX_FINDINGS', 'END_UX_FINDINGS', isUxFinding);
}

export function isUxFinding(v: unknown): v is UxFinding {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['heuristic'] === 'string' &&
    o['heuristic'].trim().length > 0 &&
    typeof o['surface'] === 'string' &&
    o['surface'].trim().length > 0 &&
    typeof o['title'] === 'string' &&
    o['title'].trim().length > 0 &&
    (o['severity'] === 'P0' || o['severity'] === 'P1' || o['severity'] === 'P2') &&
    typeof o['problem'] === 'string' &&
    o['problem'].trim().length > 0 &&
    typeof o['impact'] === 'string' &&
    typeof o['recommendation'] === 'string' &&
    o['recommendation'].trim().length > 0 &&
    Array.isArray(o['suspected_files']) &&
    o['suspected_files'].every((f) => typeof f === 'string') &&
    (o['scope'] === 'fix' || o['scope'] === 'feature') &&
    typeof o['confidence'] === 'number' &&
    o['confidence'] >= 0 &&
    o['confidence'] <= 1 &&
    (o['screenshot_path'] === undefined || typeof o['screenshot_path'] === 'string')
  );
}

/**
 * Stable content fingerprint for a UX finding. Hashes the normalized surface +
 * heuristic + title + problem + sorted suspected_files so the finding's
 * identity survives the agent rewording its title between runs, while still
 * distinguishing the same screen flagged for two different heuristics.
 */
export function fingerprintForUx(f: UxFinding): string {
  const parts = [
    normalizeText(f.surface),
    normalizeText(f.heuristic),
    normalizeText(f.title),
    normalizeText(f.problem),
    f.suspected_files
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .slice()
      .sort()
      .join(','),
  ].join('\n');
  return createHash('sha256').update(parts).digest('hex');
}

/* ---------- issue shape ---------- */

export function titleFor(f: UxFinding): string {
  return `[UX] ${f.surface}: ${f.title}`;
}

export function bodyFor(f: UxFinding, screenshotArtifactId: string | undefined): string {
  const shotLine = screenshotArtifactId
    ? `- Screenshot: [open in Obelisk](${obeliskArtifactUrl(screenshotArtifactId)})`
    : '_(no screenshot captured)_';
  return [
    `## Heuristic`,
    f.heuristic.trim(),
    '',
    `## Surface`,
    `\`${f.surface.trim()}\``,
    '',
    `## Problem`,
    f.problem.trim(),
    '',
    `## Impact`,
    f.impact.trim().length > 0 ? f.impact.trim() : '_(not specified)_',
    '',
    `## Recommendation`,
    f.recommendation.trim(),
    '',
    `## Severity`,
    f.severity,
    '',
    `## Scope`,
    f.scope === 'feature' ? 'Larger improvement (Feature Builder)' : 'Small fix (Bug Fixer)',
    '',
    `## Suspected files`,
    f.suspected_files.length === 0
      ? '_(none identified)_'
      : f.suspected_files.map((p) => `- \`${p}\``).join('\n'),
    '',
    `## Evidence`,
    shotLine,
    '',
    `## Confidence`,
    `${Math.round(f.confidence * 100)}%`,
    '',
    `> Filed by Obelisk UI/UX Expert. Reply \`/obelisk fix\` to assign Bug Fixer (or Feature Builder for larger scope).`,
  ].join('\n');
}

export function labelsFor(f: UxFinding): string[] {
  const routing = f.scope === 'feature' ? OBELISK_LABELS.feature : OBELISK_LABELS.fix;
  return [OBELISK_LABELS.ux, routing, f.severity];
}
