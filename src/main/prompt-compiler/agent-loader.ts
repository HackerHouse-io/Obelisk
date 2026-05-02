import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, RunnerKind } from '../../shared/types';

export interface AgentDefinition {
  name: AgentName;
  mission: string;
  defaultRunner: RunnerKind;
  defaultSkills: string[];
  permissions: string[];
  output: string;
  loop?: string[];
  /** The Markdown body below the front-matter — instructions, role, output format. */
  body: string;
}

interface AgentLoaderOptions {
  /** Per-repo override directory: `<repo>/agents/`. Tried first. */
  repoAgentsDir?: string;
  /** Built-in catalog directory: `<obelisk>/agents/`. Fallback. */
  builtinAgentsDir: string;
}

/**
 * Load an agent definition. Per-repo override (`<repo>/agents/<name>.md`)
 * wins over the built-in shipped with the app.
 */
export function loadAgent(name: AgentName, opts: AgentLoaderOptions): AgentDefinition {
  const candidates = [
    opts.repoAgentsDir ? join(opts.repoAgentsDir, `${name}.md`) : null,
    join(opts.builtinAgentsDir, `${name}.md`),
  ].filter((p): p is string => p !== null);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    const parsed = matter(raw);
    const data = parsed.data as Partial<AgentDefinition> & {
      default_runner?: string;
      default_skills?: string[];
    };
    return {
      name,
      mission: assertString(data['mission'], `${path}:mission`),
      defaultRunner: assertRunner(
        (data['default_runner'] as string | undefined) ?? data.defaultRunner,
        path,
      ),
      defaultSkills: (
        (data['default_skills'] as string[] | undefined) ??
        data.defaultSkills ??
        []
      ).slice(),
      permissions: (data.permissions ?? []).slice(),
      output: assertString(data.output, `${path}:output`),
      ...(data.loop ? { loop: data.loop.slice() } : {}),
      body: parsed.content.trim(),
    };
  }

  throw new ObeliskError(
    'AGENT_NOT_FOUND',
    `No agent definition found for '${name}'`,
    `Looked in: ${candidates.join(', ')}`,
  );
}

function assertString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ObeliskError('INVALID_INPUT', `${where} must be a non-empty string`);
  }
  return v;
}

function assertRunner(v: unknown, where: string): RunnerKind {
  if (v !== 'claude' && v !== 'codex') {
    throw new ObeliskError(
      'INVALID_INPUT',
      `${where}: default_runner must be 'claude' or 'codex' (got ${String(v)})`,
    );
  }
  return v;
}
