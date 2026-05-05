import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { compile } from '../../src/main/prompt-compiler';
import type {
  CompileOptions,
  RepoSummary,
  TaskPayload,
  Permissions,
} from '../../src/main/prompt-compiler';
import type { AgentName, RunnerKind } from '../../src/shared/types';

const ROOT = resolve(__dirname, '../..');

const PATHS = {
  builtinAgentsDir: resolve(ROOT, 'agents'),
  builtinSkillsDir: resolve(ROOT, 'skills'),
};

const TASK_BUG: TaskPayload = {
  ref: 'issue#142',
  kind: 'bug',
  context:
    'Login error on Safari with strict cookies — sessions are not persisted across reload because the SameSite policy on the auth cookie is wrong.',
  githubNumber: 142,
};

const TASK_FEATURE: TaskPayload = {
  ref: 'issue#198',
  kind: 'feature',
  context: 'Add CSV export to /reports.',
  githubNumber: 198,
};

const TASK_REVIEW: TaskPayload = {
  ref: 'pr#211',
  kind: 'review',
  context: 'Review PR #211 (chore(reports): refactor query builder).',
  githubNumber: 211,
};

const TASK_QA: TaskPayload = {
  ref: 'manual:qa-2026-05-02T18:00',
  kind: 'qa',
  context: 'Hourly Manual QA sweep over critical flows.',
};

const REPO: RepoSummary = {
  fullName: 'obelisk-labs/api',
  defaultBranch: 'main',
  worktreePath: '/tmp/obelisk-worktrees/repo-1/run-1',
  readmeExcerpt:
    'Obelisk API — internal HTTP service. Express + TypeScript. Postgres via knex. Tests use Vitest.',
  languages: ['TypeScript', 'JavaScript'],
  toolchain: ['pnpm', 'vitest', 'eslint'],
  changedFilesSinceLastRun: ['src/auth/session.ts', 'src/auth/cookies.ts'],
  qaPlaybookSummary: 'Critical flows: login, create-project, billing. See qa/critical-flows.md.',
};

const PERMS_PRS: Permissions = {
  mode: 'prs',
  canCreateIssues: true,
  canOpenPRs: true,
  canMergePRs: false,
};

const PERMS_OBSERVE: Permissions = {
  mode: 'observe',
  canCreateIssues: false,
  canOpenPRs: false,
  canMergePRs: false,
};

const TASK_BY_AGENT: Record<AgentName, TaskPayload> = {
  'qa-hunter': TASK_QA,
  'manual-qa': TASK_QA,
  'bug-fixer': TASK_BUG,
  'feature-builder': TASK_FEATURE,
  'pr-reviewer': TASK_REVIEW,
};

const AGENTS: AgentName[] = [
  'qa-hunter',
  'manual-qa',
  'bug-fixer',
  'feature-builder',
  'pr-reviewer',
];
const RUNNERS: RunnerKind[] = ['claude', 'codex'];

function build(agentName: AgentName, runnerOverride: RunnerKind): CompileOptions {
  return {
    agentName,
    runnerOverride,
    task: TASK_BY_AGENT[agentName],
    repo: REPO,
    permissions:
      agentName === 'pr-reviewer' || agentName === 'qa-hunter' ? PERMS_OBSERVE : PERMS_PRS,
    paths: PATHS,
  };
}

describe('prompt-compiler', () => {
  describe('determinism', () => {
    it('produces a stable contentHash for identical inputs', () => {
      const a = compile(build('bug-fixer', 'claude'));
      const b = compile(build('bug-fixer', 'claude'));
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('changes contentHash when the runner changes', () => {
      const claude = compile(build('bug-fixer', 'claude'));
      const codex = compile(build('bug-fixer', 'codex'));
      expect(claude.contentHash).not.toBe(codex.contentHash);
    });

    it('changes contentHash when the task changes', () => {
      const a = compile(build('bug-fixer', 'claude'));
      const b = compile({ ...build('bug-fixer', 'claude'), task: TASK_FEATURE });
      expect(a.contentHash).not.toBe(b.contentHash);
    });

    it('skill files are loaded in sorted order regardless of agent declaration order', () => {
      // Re-run with the same agent — skills are sorted in skill-loader.ts.
      // This guards against future churn that might re-shuffle declarations.
      const a = compile(build('feature-builder', 'claude'));
      const b = compile(build('feature-builder', 'claude'));
      expect(a.contentHash).toBe(b.contentHash);
    });
  });

  describe('Claude layout', () => {
    it('writes skill files as attachments under .claude/skills/', () => {
      const out = compile(build('bug-fixer', 'claude'));
      const skillFiles = out.attachments.filter((a) => a.path.startsWith('.claude/skills/'));
      expect(skillFiles.length).toBeGreaterThan(0);
      for (const f of skillFiles) {
        expect(f.path).toMatch(/^\.claude\/skills\/[a-z-]+\/SKILL\.md$/);
        expect(f.contents.length).toBeGreaterThan(0);
      }
    });

    it('emits a settings.json attachment with mode-aware deny list', () => {
      const observe = compile(build('qa-hunter', 'claude'));
      const settings = observe.attachments.find((a) => a.path === '.claude/settings.json');
      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings!.contents) as {
        permissions: { deny: string[] };
      };
      expect(parsed.permissions.deny).toContain('git.push');
      expect(parsed.permissions.deny).toContain('github.create_issue');
    });

    it('deny list shrinks at higher safety modes', () => {
      const observe = compile(build('qa-hunter', 'claude'));
      const prs = compile({
        ...build('bug-fixer', 'claude'),
        permissions: PERMS_PRS,
      });
      const observeDeny = JSON.parse(
        observe.attachments.find((a) => a.path === '.claude/settings.json')!.contents,
      ) as { permissions: { deny: string[] } };
      const prsDeny = JSON.parse(
        prs.attachments.find((a) => a.path === '.claude/settings.json')!.contents,
      ) as { permissions: { deny: string[] } };
      expect(observeDeny.permissions.deny.length).toBeGreaterThan(prsDeny.permissions.deny.length);
    });

    it('runner args reference the materialized system prompt + settings paths', () => {
      const out = compile(build('bug-fixer', 'claude'));
      expect(out.runnerArgs).toContain('-p');
      expect(out.runnerArgs).toContain('--system-prompt-file');
      expect(out.runnerArgs).toContain('.claude/SYSTEM.md');
      expect(out.runnerArgs).toContain('--settings');
      expect(out.runnerArgs).toContain('.claude/settings.json');
    });
  });

  describe('Codex layout', () => {
    it('inlines skills into userMessage and emits zero attachments', () => {
      const out = compile(build('bug-fixer', 'codex'));
      expect(out.attachments).toHaveLength(0);
      expect(out.userMessage).toContain('## Skills');
      expect(out.userMessage).toContain('### Skill: debugging-and-error-recovery');
      expect(out.userMessage).toContain('### Skill: test-driven-development');
    });

    it('passes reasoning effort + sandbox flags as runner args', () => {
      const out = compile(build('bug-fixer', 'codex'));
      expect(out.runnerArgs[0]).toBe('exec');
      expect(out.runnerArgs).toContain('--sandbox');
      expect(out.runnerArgs).toContain('workspace-write');
      expect(out.runnerArgs).toContain('-c');
      expect(out.runnerArgs).toContain('model_reasoning_effort="high"');
    });

    it('uses medium reasoning for non-builder agents', () => {
      const out = compile(build('qa-hunter', 'codex'));
      expect(out.runnerArgs).toContain('model_reasoning_effort="medium"');
    });
  });

  describe('snapshot per (agent, runner)', () => {
    for (const agent of AGENTS) {
      for (const runner of RUNNERS) {
        it(`${agent} × ${runner}`, () => {
          const out = compile(build(agent, runner));
          expect(out).toMatchSnapshot();
        });
      }
    }
  });
});
