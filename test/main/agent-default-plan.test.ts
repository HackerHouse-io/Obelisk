import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent, getAgent, updateAgent } from '../../src/main/db/agents';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-default-plan-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  const repo = createRepo({
    githubFullName: 'test/repo',
    localPath: tmp,
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

describe('Agent.defaultPlanId persistence', () => {
  it('new agents start with defaultPlanId = null', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    expect(a.defaultPlanId).toBeNull();
  });

  it('updateAgent persists defaultPlanId across reads', () => {
    const a = createAgent({ repoId, name: 'ios-qa-pilot' });
    const updated = updateAgent(a.id, { defaultPlanId: 'full-app' });
    expect(updated.defaultPlanId).toBe('full-app');
    const reread = getAgent(a.id)!;
    expect(reread.defaultPlanId).toBe('full-app');
  });

  it('clearing defaultPlanId via null is honored', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    updateAgent(a.id, { defaultPlanId: 'full-app' });
    updateAgent(a.id, { defaultPlanId: null });
    expect(getAgent(a.id)!.defaultPlanId).toBeNull();
  });

  it('omitting defaultPlanId from a patch leaves the existing value alone', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    updateAgent(a.id, { defaultPlanId: 'plan-1' });
    // Update an unrelated field — the saved plan must survive.
    updateAgent(a.id, { displayName: 'Custom name' });
    const reread = getAgent(a.id)!;
    expect(reread.displayName).toBe('Custom name');
    expect(reread.defaultPlanId).toBe('plan-1');
  });
});
