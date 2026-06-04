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
import { insertPreview } from '../../src/main/db/previews';
import { buildUxCoverageReport } from '../../src/main/coverage/ux-aggregate';
import type { AgentName } from '../../src/shared/types';

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-ux-'));
  repoPath = join(tmp, 'repo');
  mkdirSync(join(repoPath, 'src', 'auth'), { recursive: true });
  mkdirSync(join(repoPath, 'src', 'billing'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'auth', 'login.tsx'), '// auth login\n');
  writeFileSync(join(repoPath, 'src', 'billing', 'plan.tsx'), '// billing plan\n');

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.add('.');
  await git.commit('initial');

  mkdirSync(join(repoPath, 'qa'), { recursive: true });
  writeFileSync(
    join(repoPath, 'qa', 'coverage-map.md'),
    '- auth: src/auth/**\n- billing: src/billing/**\n',
  );

  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/ux',
    localPath: repoPath,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'codex',
  });
  repoId = repo.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a feature-scoped plan that the UI/UX Expert can run. */
function uxPlan(id: string, feature: string): void {
  const md = `---\nid: ${id}\nname: ${feature} UX\nscope: feature\nfeature: ${feature}\nagentName: ux-expert\ngeneratedAt: 2026-05-07T12:00:00Z\ngeneratedBy: heuristic\nversion: 1\n---\n\n## ${feature}\n\n- [ ] ${feature} home screen\n`;
  const dir = join(repoPath, 'qa', 'test-plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), md);
}

function doneUxRun(planId: string, finishedAt: string): void {
  const agent = createAgent({ repoId, name: 'ux-expert' });
  const run = createRun({
    repoId,
    agentName: 'ux-expert' as AgentName,
    agentId: agent.id,
    trigger: 'schedule',
    taskRef: `plan:${planId}`,
    runnerUsed: 'codex',
  });
  transitionRun(run.id, 'done', { outputSummary: 'ok' });
  getDb().prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(finishedAt, run.id);
}

function uxPreview(title: string, severity: 'P0' | 'P1' | 'P2', files: string[]): void {
  const agent = createAgent({ repoId, name: 'ux-expert' });
  const run = createRun({
    repoId,
    agentName: 'ux-expert' as AgentName,
    agentId: agent.id,
    trigger: 'schedule',
    runnerUsed: 'codex',
  });
  insertPreview({
    repoId,
    runId: run.id,
    agentName: 'ux-expert' as AgentName,
    payload: {
      kind: 'issue',
      title,
      body: `## Problem\nx\n\n## Suspected files\n${files.map((f) => `- \`${f}\``).join('\n')}\n`,
      labels: ['ux', 'obelisk:fix', severity],
    },
  });
}

describe('buildUxCoverageReport', () => {
  it('reports every coverage-map label as a surface, unswept by default', async () => {
    uxPlan('p-auth', 'auth');
    const report = await buildUxCoverageReport(repoId);
    expect(report.hasCoverageMap).toBe(true);
    expect(report.totalSurfaces).toBe(2);
    expect(report.sweptSurfaces).toBe(0);
    const auth = report.surfaces.find((s) => s.label === 'auth')!;
    expect(auth.uxHealth).toBe('unswept');
    expect(auth.swept).toBe(false);
    expect(auth.planCount).toBe(1);
    expect(auth.coverageScore).toBe(0);
  });

  it('marks a surface swept once a done ux-expert run lands, with no debt → healthy', async () => {
    uxPlan('p-auth', 'auth');
    doneUxRun('p-auth', '2026-06-01T10:00:00.000Z');
    const report = await buildUxCoverageReport(repoId);
    const auth = report.surfaces.find((s) => s.label === 'auth')!;
    expect(auth.swept).toBe(true);
    expect(auth.lastSweptAt).toBe('2026-06-01T10:00:00.000Z');
    expect(auth.uxHealth).toBe('healthy');
    expect(auth.coverageScore).toBe(100);
    expect(report.sweptSurfaces).toBe(1);
    expect(report.lastSweptAt).toBe('2026-06-01T10:00:00.000Z');
  });

  it('counts open ux findings by severity and flips health to attention', async () => {
    uxPlan('p-auth', 'auth');
    doneUxRun('p-auth', '2026-06-01T10:00:00.000Z');
    uxPreview('[UX] Login: weak contrast', 'P1', ['src/auth/login.tsx:10']);
    uxPreview('[UX] Login: tiny tap target', 'P2', ['src/auth/login.tsx:22']);
    const report = await buildUxCoverageReport(repoId);
    const auth = report.surfaces.find((s) => s.label === 'auth')!;
    expect(auth.openFindings).toBe(2);
    expect(auth.bySeverity).toEqual({ P0: 0, P1: 1, P2: 1 });
    expect(auth.uxHealth).toBe('attention');
    // swept but with P1+P2 debt → 100 - (20 + 8) = 72.
    expect(auth.coverageScore).toBe(72);
    // The other surface saw no findings.
    const billing = report.surfaces.find((s) => s.label === 'billing')!;
    expect(billing.openFindings).toBe(0);
  });

  it('a whole-app ux sweep marks every surface swept', async () => {
    // whole-app plan (no feature) the UI/UX Expert runs.
    const md = `---\nid: p-all\nname: Whole app UX\nscope: whole-app\nfeature: null\nagentName: ux-expert\ngeneratedAt: 2026-05-07T12:00:00Z\ngeneratedBy: heuristic\nversion: 1\n---\n\n## App\n\n- [ ] sweep everything\n`;
    const dir = join(repoPath, 'qa', 'test-plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'p-all.md'), md);
    doneUxRun('p-all', '2026-06-02T09:00:00.000Z');
    const report = await buildUxCoverageReport(repoId);
    expect(report.sweptSurfaces).toBe(report.totalSurfaces);
    expect(report.wholeAppPlans).toHaveLength(1);
    for (const s of report.surfaces) expect(s.swept).toBe(true);
  });
});
