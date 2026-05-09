import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldFile } from '../../util/scaffold-file';

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

/**
 * Slice the agent's reasoning for the most recent BEGIN/END memory
 * block. Returns the trimmed body (without the markers) or null when
 * no block exists. If the agent emitted multiple blocks, returns the
 * last one — the agent is instructed to emit at most one, but a stray
 * earlier block from in-context examples shouldn't override the real
 * end-of-run update.
 */
export function parseMemoryUpdate(reasoning: string | null | undefined): string | null {
  if (!reasoning) return null;
  // Use a global regex and pick the last match.
  const re = new RegExp(`${BEGIN}\\s*\\n([\\s\\S]*?)\\n${END}`, 'g');
  let last: string | null = null;
  for (const m of reasoning.matchAll(re)) {
    last = m[1] ?? null;
  }
  if (last == null) return null;
  const trimmed = last.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Apply an update to `qa/ios-pilot-memory.md` in the repo. Heading-level
 * merge: each H2 in the update either replaces an existing section
 * with the same title (case-insensitive) or appends. Content above the
 * first H2 in the file is preserved; content above the first H2 in the
 * update is dropped (agents are told to start with an H2).
 *
 * Always writes a trailing newline. Creates the file + qa/ dir on
 * first call. Idempotent for the same input.
 */
export function applyMemoryUpdate(repoPath: string, update: string): void {
  const filePath = join(repoPath, MEMORY_FILE_REL);
  const existing = readExisting(filePath);
  const merged = mergeByH2(existing, update);
  mkdirSync(join(repoPath, 'qa'), { recursive: true });
  writeFileSync(filePath, merged, 'utf8');
}

/**
 * Write a starter memory file with the canonical headings if it
 * doesn't already exist. Idempotent — never overwrites existing
 * content.
 */
export function scaffoldMemoryFile(repoPath: string): boolean {
  const lines: string[] = [
    '<!--',
    'iOS QA Pilot memory. The agent reads this file at the start of each',
    'run and writes new entries at the end. You can hand-edit any section.',
    'Use H2 headings — the agent merges by heading title.',
    '-->',
    '',
  ];
  for (const h of CANONICAL_MEMORY_HEADINGS) {
    lines.push(`## ${h}`, '', '_(empty — agent will populate over time)_', '');
  }
  return scaffoldFile(join(repoPath, MEMORY_FILE_REL), lines.join('\n'));
}

/* ---------- internals ---------- */

interface Section {
  /** Heading text without the leading `## `. */
  title: string;
  /** Body lines (excluding the heading line). */
  body: string[];
}

function readExisting(filePath: string): { preamble: string[]; sections: Section[] } {
  if (!existsSync(filePath)) return { preamble: [], sections: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { preamble: [], sections: [] };
  }
  return splitByH2(raw);
}

function splitByH2(raw: string): { preamble: string[]; sections: Section[] } {
  const lines = raw.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1]!, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function mergeByH2(existing: { preamble: string[]; sections: Section[] }, update: string): string {
  const updateParsed = splitByH2(update);
  // Drop the update's preamble — agents are told to start with H2.
  const updateByKey = new Map<string, Section>();
  for (const s of updateParsed.sections) {
    updateByKey.set(s.title.toLowerCase(), s);
  }

  const out: Section[] = [];
  const usedFromUpdate = new Set<string>();

  for (const s of existing.sections) {
    const key = s.title.toLowerCase();
    const replacement = updateByKey.get(key);
    if (replacement) {
      out.push(replacement);
      usedFromUpdate.add(key);
    } else {
      out.push(s);
    }
  }
  for (const s of updateParsed.sections) {
    if (!usedFromUpdate.has(s.title.toLowerCase())) {
      out.push(s);
    }
  }

  const lines: string[] = [];
  if (existing.preamble.length > 0) {
    lines.push(...existing.preamble);
    // Trim trailing blank lines from the preamble before the first
    // section so the layout stays consistent across rewrites.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('');
  }
  for (const s of out) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`## ${s.title}`);
    let body = s.body.slice();
    // Strip leading blank lines from each section body so titles sit
    // tight against their content.
    while (body.length > 0 && body[0] === '') body.shift();
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    if (body.length > 0) {
      lines.push('', ...body);
    }
  }
  // Always end with a single trailing newline.
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}
