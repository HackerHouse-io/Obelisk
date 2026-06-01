import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { simpleGit } from 'simple-git';
import { closeDb, getDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { worktreeReaperSweep } from '../../src/main/scheduler/worktree-reaper';

let tmp: string;
let workDir: string;
let repoId: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-reaper-'));
  workDir = join(tmp, 'repo');
  await simpleGit({ baseDir: tmp }).raw(['init', workDir, '--initial-branch=main']);
  const repo = simpleGit(workDir);
  await repo.addConfig('user.email', 't@e.com');
  await repo.addConfig('user.name', 'T');
  await repo.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(workDir, 'a.txt'), 'hi\n');
  await repo.add('.');
  await repo.commit('init');

  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: workDir,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** Add a real linked worktree at `dir` checked out on `branch`. */
async function addWorktree(dir: string, branch: string): Promise<void> {
  const repo = simpleGit(workDir);
  await repo.raw(['branch', branch]).catch(() => undefined);
  await repo.raw(['worktree', 'add', dir, branch]);
}

describe('worktreeReaperSweep — live-run guard', () => {
  it('does NOT reap a live run’s worktree attached to another run’s branch (PR Reviewer fix mode)', async () => {
    // The PR's branch belongs to the ORIGINAL run, which is gone from the DB.
    const originalRunId = ulid();
    const branch = `obelisk/${originalRunId}`;
    // The LIVE PR-Reviewer run owns a worktree whose DIR carries its own id.
    const liveRunId = ulid();
    const wtDir = join(tmp, `${liveRunId}-pr26`);
    await addWorktree(wtDir, branch);

    const agent = createAgent({ repoId, name: 'pr-reviewer' });
    const run = createRun({
      repoId,
      agentName: 'pr-reviewer',
      agentId: agent.id,
      trigger: 'schedule',
      taskRef: 'pr#26@abc',
      runnerUsed: 'claude',
    });
    // Force the row's id to liveRunId so the dir basename matches its owner,
    // then mark it running with the worktree path.
    getDb().prepare('UPDATE runs SET id = ? WHERE id = ?').run(liveRunId, run.id);
    transitionRun(liveRunId, 'running', { worktreePath: wtDir });

    // Original run is intentionally absent from the DB.
    expect(existsSync(wtDir)).toBe(true);
    await worktreeReaperSweep();
    // The live worktree must survive — this was the bug that killed PR Reviewer.
    expect(existsSync(wtDir)).toBe(true);
  });

  it('still reaps a genuinely orphaned worktree (terminal run, finished >24h ago)', async () => {
    const runId = ulid();
    const wtDir = join(tmp, `${runId}`);
    await addWorktree(wtDir, `obelisk/${runId}`);

    const agent = createAgent({ repoId, name: 'bug-fixer' });
    const created = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'schedule',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    getDb().prepare('UPDATE runs SET id = ? WHERE id = ?').run(runId, created.id);
    transitionRun(runId, 'failed', { worktreePath: wtDir, errorCode: 'INTERNAL' });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    getDb().prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(old, runId);

    expect(existsSync(wtDir)).toBe(true);
    await worktreeReaperSweep();
    expect(existsSync(wtDir)).toBe(false);
  });
});
