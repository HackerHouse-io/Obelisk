import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { appendAudit, _resetSystemSentinelCacheForTesting } from '../../src/main/logger/audit';
import { handleBugFixerHealth } from '../../src/main/ipc/bug-fixer-health';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-health-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  _resetSystemSentinelCacheForTesting();
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;

  // The audit module lazily seeds a `runs.id = 'system'` sentinel the
  // first time `appendAudit({ runId: 'system' })` is called. The health
  // IPC excludes that row from its counts via id != 'system'.
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('handleBugFixerHealth', () => {
  it('returns zeros when nothing has happened', async () => {
    const out = await handleBugFixerHealth({ repoId });
    expect(out).toMatchObject({
      prsOpened: 0,
      runsDone: 0,
      runsFailed: 0,
      scopeTooWide: 0,
      rebaseSuccess: 0,
      rebaseConflict: 0,
      rebaseError: 0,
      rebaseEscalated: 0,
      ciRetrySuccess: 0,
      ciRetryFailed: 0,
      ciRetryEscalated: 0,
      crossInstallSkipped: 0,
      claimSignalReaped: 0,
    });
    // windowStart looks like an ISO timestamp.
    expect(out.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('aggregates rebase / ci-retry outcomes by audit row', async () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 1, outcome: 'success' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 2, outcome: 'conflict' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 3, outcome: 'error' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 4, outcome: 'success' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 5, outcome: 'failed' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 6, outcome: 'escalated' },
    });
    appendAudit({
      runId: 'system',
      kind: 'cross_install_skipped',
      payload: { source: 'issue#7', login: 'user1' },
    });
    appendAudit({
      runId: 'system',
      kind: 'claim_signal_reaped',
      payload: { issueNumber: 8, reason: 'no_owning_run' },
    });

    const out = await handleBugFixerHealth({ repoId });
    expect(out.rebaseSuccess).toBe(1);
    expect(out.rebaseConflict).toBe(1);
    expect(out.rebaseError).toBe(1);
    expect(out.ciRetrySuccess).toBe(1);
    expect(out.ciRetryFailed).toBe(1);
    expect(out.ciRetryEscalated).toBe(1);
    expect(out.crossInstallSkipped).toBe(1);
    expect(out.claimSignalReaped).toBe(1);
  });

  it('counts bug-fixer runs by terminal state but ignores other agents', async () => {
    const bugFixer = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const qaHunter = createAgent({ repoId, name: 'qa-hunter', enabled: true });

    const r1 = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: bugFixer.id,
      trigger: 'manual',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    transitionRun(r1.id, 'done');
    const r2 = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: bugFixer.id,
      trigger: 'manual',
      taskRef: 'issue#2',
      runnerUsed: 'claude',
    });
    transitionRun(r2.id, 'failed');
    const r3 = createRun({
      repoId,
      agentName: 'qa-hunter',
      agentId: qaHunter.id,
      trigger: 'manual',
      taskRef: 'plan:full',
      runnerUsed: 'claude',
    });
    transitionRun(r3.id, 'done');

    const out = await handleBugFixerHealth({ repoId });
    expect(out.runsDone).toBe(1);
    expect(out.runsFailed).toBe(1);
  });

  it('counts published PRs only (not issues / comments)', async () => {
    const bugFixer = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const r = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: bugFixer.id,
      trigger: 'manual',
      taskRef: 'issue#1',
      runnerUsed: 'claude',
    });
    transitionRun(r.id, 'done');
    appendAudit({ runId: r.id, kind: 'published', payload: { kind: 'pr', prNumber: 9 } });
    appendAudit({ runId: r.id, kind: 'published', payload: { kind: 'issue', issueNumber: 11 } });

    const out = await handleBugFixerHealth({ repoId });
    expect(out.prsOpened).toBe(1);
  });

  it('only counts events inside the rolling 7-day window', async () => {
    // First call lands the lazy `runs.id='system'` sentinel so the raw
    // INSERT below satisfies the audit_log → runs FK.
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 2, outcome: 'success' },
    });

    // Insert a row 8 days ago by manually setting `at` outside the window.
    const oldAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare(
        `INSERT INTO audit_log (run_id, at, kind, payload) VALUES ('system', ?, 'pr_rebase_attempt', ?)`,
      )
      .run(oldAt, JSON.stringify({ prNumber: 1, outcome: 'success' }));

    const out = await handleBugFixerHealth({ repoId });
    expect(out.rebaseSuccess).toBe(1); // only the recent one counts
  });
});
