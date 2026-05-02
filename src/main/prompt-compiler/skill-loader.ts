import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ObeliskError } from '../../shared/errors';

export interface SkillDefinition {
  name: string;
  body: string;
}

interface SkillLoaderOptions {
  /** Per-repo override: `<repo>/skills/<name>/SKILL.md`. Tried first. */
  repoSkillsDir?: string;
  /** Built-in catalog: `<obelisk>/skills/<name>/SKILL.md`. Fallback. */
  builtinSkillsDir: string;
}

/**
 * Load a list of skills, sorted by name (deterministic for hashing).
 * Per-repo override wins over built-in.
 */
export function loadSkills(names: string[], opts: SkillLoaderOptions): SkillDefinition[] {
  const sorted = [...names].sort();
  return sorted.map((name) => loadSkill(name, opts));
}

function loadSkill(name: string, opts: SkillLoaderOptions): SkillDefinition {
  const candidates = [
    opts.repoSkillsDir ? join(opts.repoSkillsDir, name, 'SKILL.md') : null,
    join(opts.builtinSkillsDir, name, 'SKILL.md'),
  ].filter((p): p is string => p !== null);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return { name, body: readFileSync(path, 'utf8').trim() };
  }

  throw new ObeliskError(
    'NOT_FOUND',
    `Skill '${name}' not found`,
    `Looked in: ${candidates.join(', ')}`,
  );
}
