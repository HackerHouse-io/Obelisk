/**
 * Cross-check the `## Evidence` section in a PR body for completeness.
 *
 * The publisher's `pr-body.ts` always emits `### Tests`, `### Screenshots`,
 * `### Logs`, and `### Reasoning` subheadings under `## Evidence`. Each
 * subheading either lists artifacts (one per bullet line) or contains the
 * placeholder `_(none referenced for this change)_`. PR Reviewer's job is
 * to refuse to approve PRs where required subheadings are placeholder-only.
 */

export interface EvidenceCrossCheck {
  hasEvidenceSection: boolean;
  /** Subheadings that exist but only contain the placeholder. */
  emptySubheadings: string[];
  /** Subheadings the publisher requires but couldn't find at all. */
  missingSubheadings: string[];
}

const EVIDENCE_HEADER_RE = /^##\s+Evidence\s*$/im;
const SUB_RE = /^###\s+(Tests|Screenshots|Logs|Reasoning)\s*$/gim;
const PLACEHOLDER_RE = /_\(none referenced for this change\)_/i;
// A subheading the producer marked "not applicable to this change" (e.g.
// `_(not applicable — no UI changes in this PR)_`). The producer is kind-aware
// (src/main/evidence/pr-body.ts → check.ts skips screenshots when `!uiTouched`,
// logs when `!backendTouched`), so this is an affirmative "no proof is needed
// here", NOT a missing-evidence gap. It counts as a satisfied subheading.
const NOT_APPLICABLE_RE = /_\(not applicable[^)]*\)_/i;

const REQUIRED = ['Tests', 'Screenshots', 'Logs', 'Reasoning'] as const;

export function crossCheckEvidence(prBody: string): EvidenceCrossCheck {
  if (!EVIDENCE_HEADER_RE.test(prBody)) {
    return {
      hasEvidenceSection: false,
      emptySubheadings: [],
      missingSubheadings: [...REQUIRED],
    };
  }

  // Slice from `## Evidence` to the next `## ` (or end of body).
  const startIdx = prBody.search(EVIDENCE_HEADER_RE);
  const after = prBody.slice(startIdx).replace(EVIDENCE_HEADER_RE, '');
  const nextH2 = after.search(/^##\s+/m);
  const evidenceBlock = nextH2 >= 0 ? after.slice(0, nextH2) : after;

  // Walk subheadings and capture each subheading's body until the next ###.
  const matches: { name: string; body: string }[] = [];
  const headers: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  SUB_RE.lastIndex = 0;
  while ((m = SUB_RE.exec(evidenceBlock)) !== null) {
    headers.push({ name: m[1]!, index: m.index + m[0]!.length });
  }
  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i]!.index;
    const end =
      i + 1 < headers.length
        ? headers[i + 1]!.index - headers[i + 1]!.name.length - 5
        : evidenceBlock.length;
    matches.push({ name: headers[i]!.name, body: evidenceBlock.slice(start, end).trim() });
  }

  const found = new Set(matches.map((s) => s.name));
  const missing = REQUIRED.filter((r) => !found.has(r));
  const empty = matches
    // A "not applicable" subheading is affirmatively satisfied — never empty.
    .filter((s) => !NOT_APPLICABLE_RE.test(s.body))
    .filter((s) => PLACEHOLDER_RE.test(s.body) || s.body.length === 0)
    .map((s) => s.name);

  return {
    hasEvidenceSection: true,
    emptySubheadings: empty,
    missingSubheadings: missing,
  };
}

export function isEvidenceComplete(check: EvidenceCrossCheck): boolean {
  if (!check.hasEvidenceSection) return false;
  // For Phase 8, Reasoning is allowed to be a non-empty placeholder paragraph
  // ("See the `## Reasoning` section below…"); the strictly-required ones are
  // Tests + Screenshots + Logs.
  const required = new Set(['Tests', 'Screenshots', 'Logs']);
  if (check.missingSubheadings.some((s) => required.has(s))) return false;
  if (check.emptySubheadings.some((s) => required.has(s))) return false;
  return true;
}
