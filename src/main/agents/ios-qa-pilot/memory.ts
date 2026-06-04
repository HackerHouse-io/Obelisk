import { join } from 'node:path';
import {
  applySectionMemoryUpdate,
  parseSectionMemoryUpdate,
  scaffoldSectionMemory,
} from '../../util/section-memory';

/**
 * Per-project iOS QA Pilot memory file. Lives in the user's repo at a
 * stable path so:
 *   1. Subsequent runs read it via `readQaPlaybookSummary` (the
 *      orchestrator already walks `qa/*.md` and inlines the contents
 *      in the agent's prompt — no extra plumbing needed).
 *   2. Users can hand-edit project quirks the agent should respect.
 *
 * Append-only by section: H2 headings written by the agent OVERWRITE
 * a same-titled section in the file; new H2 headings append to the
 * end. Anything outside H2 sections is left untouched.
 */
export const MEMORY_FILE_REL = 'qa/ios-pilot-memory.md';

/**
 * Canonical sections the agent is told to maintain. Order matters —
 * the agent reads top-down and the orchestrator's heading-level merge
 * preserves order, so the most navigation-critical sections sit first
 * to bias the agent toward "use cached path" before "go re-derive".
 */
export const CANONICAL_MEMORY_HEADINGS = [
  // Token-saving fast paths the agent must consult before walking the
  // app. Cached navigation steps + state-injection recipes (deep
  // links, simctl data restore, fixture profiles).
  'Navigation cache',
  // Stable architectural facts (tab structure, screen names, entry
  // points). Read once, rarely changes.
  'App architecture',
  // Selectors that worked. Reuse instead of re-discovering.
  'Useful selectors',
  // Suppressors. Match against any candidate finding before filing.
  'Known non-bugs',
  // Already-filed bugs in the current cycle. Suppress duplicates.
  'Filed findings',
] as const;

const BEGIN = 'BEGIN_IOS_MEMORY_UPDATE';
const END = 'END_IOS_MEMORY_UPDATE';

/** Slice the agent's reasoning for the most recent memory block (or null). */
export function parseMemoryUpdate(reasoning: string | null | undefined): string | null {
  return parseSectionMemoryUpdate(reasoning, BEGIN, END);
}

/**
 * Apply a heading-level merge update to `qa/ios-pilot-memory.md` in the repo.
 * See `section-memory.ts` for the merge semantics.
 */
export function applyMemoryUpdate(repoPath: string, update: string): void {
  applySectionMemoryUpdate(join(repoPath, MEMORY_FILE_REL), update);
}

/** Write a starter memory file with the canonical headings if absent. */
export function scaffoldMemoryFile(repoPath: string): boolean {
  return scaffoldSectionMemory(join(repoPath, MEMORY_FILE_REL), CANONICAL_MEMORY_HEADINGS, [
    'iOS QA Pilot memory. The agent reads this file at the start of each',
    'run and writes new entries at the end. You can hand-edit any section.',
    'Use H2 headings — the agent merges by heading title.',
  ]);
}
