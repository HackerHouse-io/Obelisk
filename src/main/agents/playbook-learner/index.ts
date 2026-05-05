import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../../../shared/types';

/**
 * Post-run hook: scan an agent's filesChanged for newly-introduced files
 * that look like user-facing flows (routes, pages, screens) and append
 * stub entries to `qa/critical-flows.md` so the playbook stays current.
 *
 * Only appends — never deletes or rewrites existing entries. Skips
 * anything already mentioned by name in the file.
 */
export interface LearnInput {
  repo: Repo;
  filesChanged: string[];
}

export interface LearnOutput {
  appendedFlows: string[];
}

export function learnFromPatch(input: LearnInput): LearnOutput {
  const flows = inferFlowsFromPaths(input.filesChanged);
  if (flows.length === 0) return { appendedFlows: [] };

  // We don't create critical-flows.md from this hook — the bootstrapper owns
  // initial creation; a missing read here just means there's nothing to append to.
  const flowsFilePath = join(input.repo.localPath, 'qa', 'critical-flows.md');
  try {
    const body = readFileSync(flowsFilePath, 'utf8');
    const novel = flows.filter((f) => !mentions(body, f.name));
    if (novel.length === 0) return { appendedFlows: [] };
    const block = renderAppendBlock(novel);
    writeFileSync(flowsFilePath, body.trimEnd() + '\n\n' + block + '\n', 'utf8');
    return { appendedFlows: novel.map((n) => n.name) };
  } catch {
    return { appendedFlows: [] };
  }
}

interface InferredFlow {
  name: string;
  source: string;
}

function inferFlowsFromPaths(paths: string[]): InferredFlow[] {
  const seen = new Set<string>();
  const out: InferredFlow[] = [];
  for (const p of paths) {
    const flow = inferOne(p);
    if (!flow) continue;
    const key = flow.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flow);
  }
  return out;
}

function inferOne(path: string): InferredFlow | null {
  // Next.js app router: app/<segment>/page.tsx
  const nextApp = path.match(/(?:^|\/)app\/(.+)\/page\.(tsx|jsx|ts|js)$/);
  if (nextApp) return { name: humanize(nextApp[1]!), source: path };

  // Next.js pages router: pages/<segment>.tsx (excluding _app, _document, api)
  const nextPages = path.match(/(?:^|\/)pages\/(?!_|api\/)(.+)\.(tsx|jsx|ts|js)$/);
  if (nextPages) return { name: humanize(nextPages[1]!), source: path };

  // React-style screens / pages
  const screen = path.match(/(?:^|\/)src\/(?:screens|pages|views)\/(.+)\.(tsx|jsx)$/);
  if (screen) return { name: humanize(screen[1]!), source: path };

  // Express/Fastify route files: src/routes/<name>.ts (skip generic index.ts)
  const route = path.match(/(?:^|\/)(?:src\/)?routes\/(?!index\b)([\w-]+)\.(ts|js)$/);
  if (route) return { name: humanize(route[1]!) + ' route', source: path };

  return null;
}

function humanize(slug: string): string {
  // Strip dynamic segments like [id] or (group) and underscores; titlecase.
  return slug
    .replace(/\[\.\.\..+?\]|\[.+?\]/g, '')
    .replace(/\(.+?\)/g, '')
    .replace(/[/_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

function mentions(body: string, name: string): boolean {
  return body.toLowerCase().includes(name.toLowerCase());
}

function renderAppendBlock(flows: InferredFlow[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = flows.map(
    (f) => `- **${f.name}** — discovered in \`${f.source}\` (stub, please flesh out)`,
  );
  return `### Discovered ${today}\n\n${lines.join('\n')}`;
}
