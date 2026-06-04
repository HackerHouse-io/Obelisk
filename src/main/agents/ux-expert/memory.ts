import { join } from 'node:path';
import {
  applySectionMemoryUpdate,
  parseSectionMemoryUpdate,
  readSectionMemory,
} from '../../util/section-memory';

/**
 * Per-PLAN UI/UX Expert memory. Driving a web/Electron app through Playwright
 * is token-expensive, so each run records what it learned — routes, the
 * cheapest click-path to each surface, stable selectors / button text — and
 * the next run over the SAME plan reads it back and jumps straight to each
 * screen instead of re-discovering the DOM.
 *
 * Scoped per plan (`qa/ux-memory/<planId>.md`), not per repo, because:
 *   - A run is plan-driven; the relevant navigation is exactly that plan's
 *     surfaces. The whole-app sweep (the primary "Run UX coverage pass" path)
 *     accumulates one rich full-app map that's reused on every sweep.
 *   - Each run injects ONLY its own plan's memory — never the whole repo's —
 *     so the prompt stays small and other agents/plans aren't bloated.
 *
 * These files live OUTSIDE the global `qa/*.md` playbook walk on purpose
 * (`readQaPlaybookSummary` skips the `ux-memory/` subtree): we inject the
 * matching plan's file directly in `selectTask`, so it never leaks into other
 * agents' prompts.
 */
export const UX_MEMORY_DIR_REL = 'qa/ux-memory';

/**
 * Canonical sections, ordered so the most token-saving facts sit first — the
 * agent reads top-down and should reuse the cached path before re-deriving it.
 */
export const UX_MEMORY_HEADINGS = [
  // The cheapest route + click-path to each surface. The biggest token saver.
  'Navigation map',
  // Stable selectors / roles / button text that worked. Reuse, don't re-find.
  'Selectors',
  // App-shell facts: nav structure, layout regions, design-system tokens.
  'App shell',
  // Surfaces already audited + their UX baseline, so stable screens aren't
  // deep-dived again from scratch.
  'Audited surfaces',
  // Intentional design choices confirmed NOT to be issues — don't re-flag.
  'Known non-issues',
] as const;

const BEGIN = 'BEGIN_UX_MEMORY_UPDATE';
const END = 'END_UX_MEMORY_UPDATE';

/** Relative path (within the repo) of a plan's memory file. */
export function uxMemoryRelPath(planId: string): string {
  return `${UX_MEMORY_DIR_REL}/${sanitizePlanId(planId)}.md`;
}

/** Read a plan's memory, capped so an oversized file can't blow the prompt. */
export function readUxMemory(repoPath: string, planId: string): string {
  return readSectionMemory(join(repoPath, uxMemoryRelPath(planId)));
}

/** Slice the most recent BEGIN_UX_MEMORY_UPDATE block from the agent output. */
export function parseUxMemoryUpdate(reasoning: string | null | undefined): string | null {
  return parseSectionMemoryUpdate(reasoning, BEGIN, END);
}

/** Heading-level merge of an update into the plan's memory file. */
export function applyUxMemoryUpdate(repoPath: string, planId: string, update: string): void {
  applySectionMemoryUpdate(join(repoPath, uxMemoryRelPath(planId)), update);
}

/** Keep ids filesystem-safe — plan ids are ULIDs, but guard hint-supplied ids. */
function sanitizePlanId(planId: string): string {
  return planId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'plan';
}
