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

describe('agents:create singleton enforcement', () => {
  it('multi-instance type allows N instances', async () => {
    const a = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    const b = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    expect(a.id).not.toBe(b.id);
    expect(a.displayName).toBe('Bug Fixer');
    expect(b.displayName).toBe('Bug Fixer 2');
    expect(a.multiInstance).toBe(true);
  });

  it('singleton type rejects a 2nd instance with AGENT_SINGLETON', async () => {
    await handleAgentsCreate({ repoId, name: 'qa-hunter' });
    await expect(handleAgentsCreate({ repoId, name: 'qa-hunter' })).rejects.toMatchObject({
      code: 'AGENT_SINGLETON',
    });
  });

  it('singleton clone is also rejected', async () => {
    const first = await handleAgentsCreate({ repoId, name: 'qa-hunter' });
    await expect(handleAgentsClone({ agentId: first.id })).rejects.toMatchObject({
      code: 'AGENT_SINGLETON',
    });
  });

  it('clone of a multi-instance agent lands disabled', async () => {
    const first = await handleAgentsCreate({ repoId, name: 'bug-fixer' });
    const cloned = await handleAgentsClone({ agentId: first.id });
    expect(cloned.id).not.toBe(first.id);
    expect(cloned.enabled).toBe(false); // explicit user enable prevents 2× billing
    expect(cloned.displayName).toBe('Bug Fixer 2');
  });
});
