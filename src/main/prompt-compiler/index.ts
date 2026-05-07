import { loadAgent } from './agent-loader';
import { loadSkills } from './skill-loader';
import { compileClaude } from './claude-layout';
import { compileCodex } from './codex-layout';
import { canonicalStringify } from './canonical-json';
import { sha256 } from './hash';
import type { CompileOptions, CompiledPrompt, CompileInput } from './types';

export type {
  CompileOptions,
  CompiledPrompt,
  TaskPayload,
  RepoSummary,
  Permissions,
} from './types';

/**
 * Pure function: same inputs → same `contentHash` and same emitted layout.
 * No I/O outside reading agent/skill files (which are content-addressed via
 * the hash, not by mtime).
 */
export function compile(opts: CompileOptions): CompiledPrompt {
  const builtinAgentsLoaderOpts = {
    builtinAgentsDir: opts.paths.builtinAgentsDir,
    ...(opts.paths.repoAgentsDir ? { repoAgentsDir: opts.paths.repoAgentsDir } : {}),
  };
  const agent = loadAgent(opts.agentName, builtinAgentsLoaderOpts);
  const runnerKind = opts.runnerOverride ?? agent.defaultRunner;

  const builtinSkillsLoaderOpts = {
    builtinSkillsDir: opts.paths.builtinSkillsDir,
    ...(opts.paths.repoSkillsDir ? { repoSkillsDir: opts.paths.repoSkillsDir } : {}),
  };
  const skills = loadSkills(agent.defaultSkills, builtinSkillsLoaderOpts);

  const input: CompileInput = {
    agent,
    skills,
    task: opts.task,
    repo: opts.repo,
    runnerKind,
    permissions: opts.permissions,
    ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
  };

  const compiled = runnerKind === 'claude' ? compileClaude(input) : compileCodex(input);

  // Hash a normalized snapshot of the inputs (NOT of the rendered output —
  // the output may contain wall-clock-ish fields like worktree paths, but
  // the inputs are the source of truth for "did anything change?").
  const hashInput = canonicalStringify({
    agent: {
      name: agent.name,
      mission: agent.mission,
      defaultRunner: agent.defaultRunner,
      defaultSkills: agent.defaultSkills,
      permissions: agent.permissions,
      output: agent.output,
      loop: agent.loop ?? null,
      body: agent.body,
    },
    skills: skills.map((s) => ({ name: s.name, body: s.body })),
    runnerKind,
    modelOverride: opts.modelOverride ?? null,
    task: opts.task,
    repo: opts.repo,
    permissions: opts.permissions,
  });
  compiled.contentHash = sha256(hashInput);

  return compiled;
}
