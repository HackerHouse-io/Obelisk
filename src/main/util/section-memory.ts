import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scaffoldFile } from './scaffold-file';

/**
 * Generic "section memory": a markdown file an agent reads at the start of a
 * run and rewrites at the end, so repeated runs learn instead of re-deriving.
 *
 * The merge key is the H2 heading. An update's section REPLACES a same-titled
 * existing section (case-insensitive) or APPENDS when new; content above the
 * first H2 (the preamble) is preserved. This is the engine shared by the iOS
 * QA Pilot's per-repo memory and the UI/UX Expert's per-plan memory — only the
 * file path, markers, and canonical headings differ.
 */

/**
 * Slice the most recent BEGIN/END block out of the agent's reasoning. Returns
 * the trimmed body (markers stripped) or null. If the agent emitted multiple
 * blocks, the LAST one wins — a stray earlier block from an in-context example
 * must not override the real end-of-run update.
 */
export function parseSectionMemoryUpdate(
  reasoning: string | null | undefined,
  beginMarker: string,
  endMarker: string,
): string | null {
  if (!reasoning) return null;
  const re = new RegExp(`${beginMarker}\\s*\\n([\\s\\S]*?)\\n${endMarker}`, 'g');
  let last: string | null = null;
  for (const m of reasoning.matchAll(re)) {
    last = m[1] ?? null;
  }
  if (last == null) return null;
  const trimmed = last.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Apply an update to the memory file at `filePath`. Heading-level merge (see
 * module doc). Creates the parent dir on first call, always writes a trailing
 * newline, and is idempotent for the same input.
 */
export function applySectionMemoryUpdate(filePath: string, update: string): void {
  const existing = readExisting(filePath);
  const merged = mergeByH2(existing, update);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, merged, 'utf8');
}

/**
 * Write a starter memory file with the canonical headings if it doesn't exist.
 * Idempotent — never clobbers existing content.
 */
export function scaffoldSectionMemory(
  filePath: string,
  headings: readonly string[],
  headerComment: readonly string[],
): boolean {
  const lines: string[] = ['<!--', ...headerComment, '-->', ''];
  for (const h of headings) {
    lines.push(`## ${h}`, '', '_(empty — agent will populate over time)_', '');
  }
  return scaffoldFile(filePath, lines.join('\n'));
}

/**
 * Read the memory file, capped at `maxBytes` so an oversized file can never
 * blow the prompt budget. Returns '' when missing/unreadable. Truncates on a
 * line boundary and appends a marker so the agent knows it was clipped.
 */
export function readSectionMemory(filePath: string, maxBytes = 12 * 1024): string {
  if (!existsSync(filePath)) return '';
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
  if (raw.length <= maxBytes) return raw;
  const clipped = raw.slice(0, maxBytes);
  const lastNl = clipped.lastIndexOf('\n');
  return `${clipped.slice(0, lastNl > 0 ? lastNl : maxBytes)}\n\n_(truncated — memory exceeds budget; prune stale entries)_`;
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
  // Drop the update's preamble — agents are told to start with an H2.
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
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('');
  }
  for (const s of out) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`## ${s.title}`);
    let body = s.body.slice();
    while (body.length > 0 && body[0] === '') body.shift();
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    if (body.length > 0) {
      lines.push('', ...body);
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}
