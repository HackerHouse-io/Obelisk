import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { AgentName } from '../../shared/types';

/**
 * Read an agent's Mission text and skill list. Source resolution order:
 *   1. `<repoPath>/agents/<name>.md`     — per-repo override
 *   2. bundled `agents/<name>.md`        — built-in
 *
 * Front-matter fields recognized:
 *   - `default_skills` (array of strings)
 *   - per-repo overrides may also include `skills`
 *
 * Returns `{ source, markdown, skills }` so the renderer can render the body
 * verbatim and surface the skill chips list.
 */
export interface AgentMd {
  source: 'builtin' | 'override';
  markdown: string;
  skills: string[];
}

function resolveBuiltinAgentsDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'agents'),
    (() => {
      try {
        return join(app.getAppPath(), 'agents');
      } catch {
        return '';
      }
    })(),
    resolve(__dirname, '..', '..', '..', 'agents'),
    join(process.cwd(), 'agents'),
  ].filter((p) => p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return '';
}

export function readAgentMd(repoPath: string, name: AgentName): AgentMd {
  const overridePath = join(repoPath, 'agents', `${name}.md`);
  if (existsSync(overridePath)) {
    const md = readFileSync(overridePath, 'utf8');
    return { source: 'override', markdown: md, skills: parseSkills(md) };
  }
  const builtinDir = resolveBuiltinAgentsDir();
  if (builtinDir) {
    const builtinPath = join(builtinDir, `${name}.md`);
    if (existsSync(builtinPath)) {
      const md = readFileSync(builtinPath, 'utf8');
      return { source: 'builtin', markdown: md, skills: parseSkills(md) };
    }
  }
  return { source: 'builtin', markdown: '', skills: [] };
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---/;
const LIST_ITEM_RE = /^\s*-\s+(.+?)\s*$/;

/**
 * Tiny YAML-shaped reader: enough to pull the `default_skills:` (or `skills:`)
 * block out of an agents/<name>.md frontmatter. We avoid pulling in a full
 * YAML dependency since these files are highly structured and authored by us.
 */
export function parseSkills(markdown: string): string[] {
  const m = markdown.match(FRONTMATTER_RE);
  if (!m) return [];
  const fm = m[1] ?? '';
  const lines = fm.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (/^\s*(default_skills|skills):\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      const item = line.match(LIST_ITEM_RE);
      if (item) {
        out.push(item[1]!.replace(/^["']|["']$/g, ''));
      } else if (/^\s*\S/.test(line) && !/^\s*-\s+/.test(line)) {
        // Non-list, non-indented line — list ended.
        inList = false;
      }
    }
  }
  return out;
}
