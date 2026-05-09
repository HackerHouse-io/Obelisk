import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun, transitionRun } from '../../src/main/db/runs';
import { _resetSystemSentinelCacheForTesting } from '../../src/main/logger/audit';

let tmp: string;
let repoId: string;

const mockGh = {
  issues: {
    listForRepo: vi.fn(),
    removeLabel: vi.fn(),
    removeAssignees: vi.fn(),
  },
};

vi.mock('../../src/main/github/client', () => ({
  getGithub: () => Promise.resolve(mockGh),
}));

vi.mock('../../src/main/auth/token-store', () => ({
  getAuthedLogin: () => Promise.resolve('obelisk-test-user'),
  loadGitHubToken: () =>
    Promise.resolve({ token: 't', login: 'obelisk-test-user', scopes: ['repo'] }),
}));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-claim-reaper-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  _resetSystemSentinelCacheForTesting();
  runMigrations();
  repoId = createRepo({
    githubFullName: 'acme/app',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;

  mockGh.issues.listForRepo.mockReset();
  mockGh.issues.removeLabel.mockReset().mockResolvedValue({});
  mockGh.issues.removeAssignees.mockReset().mockResolvedValue({});
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

async function runReaper(): Promise<void> {
  const { claimSignalReaperSweep } = await import('../../src/main/scheduler/claim-signal-reaper');
  await claimSignalReaperSweep();
}

describe('claimSignalReaperSweep', () => {
  it('clears claim signals on issues whose owning run failed >24h ago', async () => {
    const agent = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const run = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'issue#42',
      runnerUsed: 'claude',
    });
    transitionRun(run.id, 'failed');
    // Backdate finished_at by 25h.
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    getDb().prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(longAgo, run.id);

    mockGh.issues.listForRepo.mockResolvedValue({
      data: [{ number: 42, pull_request: undefined }],
    });

    await runReaper();

    expect(mockGh.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, name: 'obelisk:in-progress' }),
    );
    expect(mockGh.issues.removeAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, assignees: ['obelisk-test-user'] }),
    );
  });

  it('does NOT touch issues whose owning run finished recently', async () => {
    const agent = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    const run = createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'issue#42',
      runnerUsed: 'claude',
    });
    transitionRun(run.id, 'failed'); // finished_at = now
    mockGh.issues.listForRepo.mockResolvedValue({
      data: [{ number: 42, pull_request: undefined }],
    });

    await runReaper();
    expect(mockGh.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('clears orphaned signals (no owning run row at all)', async () => {
    mockGh.issues.listForRepo.mockResolvedValue({
      data: [{ number: 99, pull_request: undefined }],
    });

    await runReaper();
    expect(mockGh.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 99 }),
    );
  });

  it('skips PRs returned by the issues endpoint (issues API is polymorphic)', async () => {
    mockGh.issues.listForRepo.mockResolvedValue({
      data: [{ number: 7, pull_request: { url: 'https://...' } }],
    });

    await runReaper();
    expect(mockGh.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('does not touch issues whose owning run is still in flight', async () => {
    const agent = createAgent({ repoId, name: 'bug-fixer', enabled: true });
    createRun({
      repoId,
      agentName: 'bug-fixer',
      agentId: agent.id,
      trigger: 'manual',
      taskRef: 'issue#42',
      runnerUsed: 'claude',
    }); // stays in 'queued'
    mockGh.issues.listForRepo.mockResolvedValue({
      data: [{ number: 42, pull_request: undefined }],
    });

    await runReaper();
    expect(mockGh.issues.removeLabel).not.toHaveBeenCalled();
  });
});
