import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closeDb, getDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { savePlan } from '../../src/main/test-plans/store';
import { insertPreview } from '../../src/main/db/previews';
import { buildCoverageReport, parseSuspectedFiles } from '../../src/main/coverage/aggregate';
import { ulid } from 'ulid';
import type { TestPlanFrontmatter } from '../../src/shared/types';

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-cov-'));
  repoPath = join(tmp, 'repo');
  mkdirSync(repoPath, { recursive: true });
  // Seed a tiny git repo so simpleGit ls-files / log work.
  mkdirSync(join(repoPath, 'src', 'auth'), { recursive: true });
  mkdirSync(join(repoPath, 'src', 'billing'), { recursive: true });
  mkdirSync(join(repoPath, 'src', 'untouched'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'auth', 'session.ts'), '// auth session\n');
  writeFileSync(join(repoPath, 'src', 'billing', 'charge.ts'), '// billing charge\n');
  writeFileSync(join(repoPath, 'src', 'untouched', 'mystery.ts'), '// no plan covers me\n');

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.add('.');
  await git.commit('initial');

  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/cov',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function plan(
  frontmatter: Partial<TestPlanFrontmatter>,
  blocks: Parameters<typeof savePlan>[0]['blocks'],
): string {
  const id = frontmatter.id ?? ulid();
  // savePlan requires the file to exist already — fake it by writing the markdown
  // directly via the parse module. Easier: use the store's helpers indirectly.
  // The `savePlan` API requires an existing file, so we write it raw.
  const md = `---\nid: ${id}\nname: ${frontmatter.name ?? 'Plan'}\nscope: ${frontmatter.scope ?? 'whole-app'}\nfeature: null\nagentName: ${frontmatter.agentName ?? 'qa-hunter'}\ngeneratedAt: 2026-05-07T12:00:00Z\ngeneratedBy: heuristic\nversion: 1\n---\n\n`;
  const dir = join(repoPath, 'qa', 'test-plans');
  mkdirSync(dir, { recursive: true });
  let body = '## Smoke\n\n';
  for (const b of blocks) {
    if (b.kind === 'section') {
      body += `## ${b.title}\n\n`;
    } else {
      const sev = b.severity ? ` severity:${b.severity}` : '';
      const sc = b.scope && b.scope.length > 0 ? ` scope:${b.scope.join(',')}` : '';
      body += `- [ ] ${b.title}${sev}${sc}\n`;
    }
  }
  writeFileSync(join(dir, `${id}.md`), md + body);
  return id;
}

function makeRun(planId: string, finishedAt: Date, state: 'done' | 'failed' = 'done'): string {
  const agent = createAgent({ repoId, name: 'qa-hunter' });
  const run = createRun({
    repoId,
    agentName: 'qa-hunter',
    agentId: agent.id,
    trigger: 'schedule',
    taskRef: `plan:${planId}`,
    runnerUsed: 'claude',
  });
  if (state === 'done') {
    transitionRun(run.id, 'done', { outputSummary: 'ok' });
  } else {
    transitionRun(run.id, 'failed', { errorCode: 'INTERNAL' });
  }
  getDb()
    .prepare('UPDATE runs SET finished_at = ? WHERE id = ?')
    .run(finishedAt.toISOString(), run.id);
  return run.id;
}

function writePreview(runId: string, title: string, suspectedFiles: string[]): void {
  insertPreview({
    repoId,
    runId,
    agentName: 'qa-hunter',
    payload: {
      kind: 'issue',
      title,
      body: `## Severity\nP1\n\n## Repro\nstuff\n\n## Suspected files\n${suspectedFiles.map((f) => `- \`${f}\``).join('\n') || '_(none identified)_'}\n\n## Suggested test\n\`\`\`\nt\n\`\`\`\n`,
      labels: ['obelisk:fix', 'P1'],
    },
  });
}

describe('parseSuspectedFiles', () => {
  it('extracts back-tick-quoted paths from the Suspected files section', () => {
    const body = `## Severity\nP0\n\n## Suspected files\n- \`src/auth/session.ts\`\n- \`src/auth/middleware.ts:42\`\n\n## Suggested test\n\`\`\`\nt\n\`\`\``;
    expect(parseSuspectedFiles(body)).toEqual(['src/auth/session.ts', 'src/auth/middleware.ts']);
  });

  it('returns [] when section is absent', () => {
    expect(parseSuspectedFiles('## Severity\nP0\n')).toEqual([]);
  });

  it('returns [] when section is "_(none identified)_"', () => {
    const body = `## Suspected files\n_(none identified)_\n\n## Suggested test\n`;
    expect(parseSuspectedFiles(body)).toEqual([]);
  });
});

describe('buildCoverageReport', () => {
  it('counts cases per file via scope→glob resolution + coverage map', async () => {
    // Coverage map: auth → src/auth/**, billing → src/billing/**
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(
      join(repoPath, 'qa', 'coverage-map.md'),
      '- auth: src/auth/**\n- billing: src/billing/**\n',
    );

    plan({ id: 'p1', name: 'Auth' }, [
      { kind: 'section', id: 's1', title: 'Auth' },
      {
        kind: 'case',
        id: 'c1',
        title: 'Sign in works',
        expected: null,
        repro: null,
        severity: 'P0',
        scope: ['auth'],
      },
      {
        kind: 'case',
        id: 'c2',
        title: 'Logout works',
        expected: null,
        repro: null,
        severity: 'P1',
        scope: ['auth'],
      },
    ]);
    plan({ id: 'p2', name: 'Billing' }, [
      { kind: 'section', id: 's2', title: 'Billing' },
      {
        kind: 'case',
        id: 'c3',
        title: 'Charge succeeds',
        expected: null,
        repro: null,
        severity: 'P0',
        scope: ['billing'],
      },
    ]);

    const report = await buildCoverageReport(repoId);
    const auth = report.files.find((f) => f.path === 'src/auth/session.ts')!;
    const billing = report.files.find((f) => f.path === 'src/billing/charge.ts')!;
    const untouched = report.files.find((f) => f.path === 'src/untouched/mystery.ts')!;
    expect(auth.caseCount).toBe(2);
    expect(billing.caseCount).toBe(1);
    expect(untouched.caseCount).toBe(0);

    expect(report.totalFiles).toBeGreaterThanOrEqual(3);
    expect(report.coveredFiles).toBe(2);
    expect(report.uncoveredFiles).toBeGreaterThanOrEqual(1);
    expect(report.features.find((f) => f.label === 'auth')?.caseCount).toBe(2);
    expect(report.features.find((f) => f.label === 'billing')?.caseCount).toBe(1);
  });

  it('falls back to substring globs when no coverage-map.md exists', async () => {
    plan({ id: 'p1', name: 'Auth' }, [
      {
        kind: 'case',
        id: 'c1',
        title: 'Sign in works',
        expected: null,
        repro: null,
        severity: 'P0',
        scope: ['auth'],
      },
    ]);

    const report = await buildCoverageReport(repoId);
    const auth = report.files.find((f) => f.path === 'src/auth/session.ts')!;
    // Fallback **/auth/** matches src/auth/session.ts.
    expect(auth.caseCount).toBe(1);
  });

  it('records lastPassedAt as the most recent done run for plans targeting the file', async () => {
    mkdirSync(join(repoPath, 'qa'), { recursive: true });
    writeFileSync(join(repoPath, 'qa', 'coverage-map.md'), '- auth: src/auth/**\n');

    const planId = plan({ id: 'p1', name: 'Auth' }, [
      {
        kind: 'case',
        id: 'c1',
        title: 'Sign in',
        expected: null,
        repro: null,
        severity: 'P0',
        scope: ['auth'],
      },
    ]);
    const oldFinished = new Date('2026-05-01T10:00:00Z');
    const newFinished = new Date('2026-05-06T10:00:00Z');
    makeRun(planId, oldFinished, 'done');
    makeRun(planId, newFinished, 'done');

    const report = await buildCoverageReport(repoId);
    const auth = report.files.find((f) => f.path === 'src/auth/session.ts')!;
    expect(auth.lastPassedAt).toBe(newFinished.toISOString());
    expect(report.lastDoneAt).toBe(newFinished.toISOString());
  });

  it('counts open previews per file via suspected_files', async () => {
    const planId = plan({ id: 'p1', name: 'Auth' }, [
      {
        kind: 'case',
        id: 'c1',
        title: 'Sign in',
        expected: null,
        repro: null,
        severity: 'P0',
        scope: ['auth'],
      },
    ]);
    const runId = makeRun(planId, new Date('2026-05-06T10:00:00Z'), 'done');
    writePreview(runId, '[bug] Login fails on Safari', ['src/auth/session.ts']);
    writePreview(runId, '[bug] Cookie not set', ['src/auth/session.ts', 'src/auth/cookie.ts']);

    const report = await buildCoverageReport(repoId);
    const auth = report.files.find((f) => f.path === 'src/auth/session.ts')!;
    expect(auth.findingsCount).toBe(2);
  });
});
