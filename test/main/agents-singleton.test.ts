import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { handleAgentsCreate, handleAgentsClone } from '../../src/main/ipc/agents';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-singleton-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('agents:create — multi-instance support', () => {
  it('Bug Fixer allows N instances with auto-numbered names', async () => {
    const a = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    const b = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    expect(a.id).not.toBe(b.id);
    expect(a.displayName).toBe('Bug Fixer');
    expect(b.displayName).toBe('Bug Fixer 2');
    expect(a.multiInstance).toBe(true);
  });

  it('QA Hunter is now multi-instance — multiple plans can run on different schedules', async () => {
    const a = await handleAgentsCreate({ repoId, name: 'qa-hunter' });
    const b = await handleAgentsCreate({ repoId, name: 'qa-hunter' });
    expect(a.id).not.toBe(b.id);
    expect(a.multiInstance).toBe(true);
    expect(b.displayName).toBe('QA Hunter 2');
  });

  it('Manual QA is now multi-instance — different feature plans can run in parallel', async () => {
    const a = await handleAgentsCreate({ repoId, name: 'manual-qa' });
    const b = await handleAgentsCreate({ repoId, name: 'manual-qa' });
    expect(a.id).not.toBe(b.id);
    expect(a.multiInstance).toBe(true);
    expect(b.displayName).toBe('Manual QA 2');
  });

  it('cloning a multi-instance agent lands disabled', async () => {
    const first = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    const cloned = await handleAgentsClone({ agentId: first.id });
    expect(cloned.id).not.toBe(first.id);
    expect(cloned.enabled).toBe(false); // explicit user enable prevents 2× billing
    expect(cloned.displayName).toBe('Bug Fixer 2');
  });

  it('cloning QA Hunter is allowed and lands disabled', async () => {
    const first = await handleAgentsCreate({ repoId, name: 'qa-hunter' });
    const cloned = await handleAgentsClone({ agentId: first.id });
    expect(cloned.id).not.toBe(first.id);
    expect(cloned.enabled).toBe(false);
    expect(cloned.displayName).toBe('QA Hunter 2');
  });
});
