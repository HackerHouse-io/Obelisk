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

describe('Agent.planSelectionMode persistence', () => {
  it('defaults to "fixed" for new agents (column starts NULL)', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    expect(a.planSelectionMode).toBe('fixed');
    expect(getAgent(a.id)!.planSelectionMode).toBe('fixed');
  });

  it('round-trips "least-covered" across reads', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    const updated = updateAgent(a.id, { planSelectionMode: 'least-covered' });
    expect(updated.planSelectionMode).toBe('least-covered');
    expect(getAgent(a.id)!.planSelectionMode).toBe('least-covered');
  });

  it('omitting planSelectionMode from a patch leaves the existing value alone', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    updateAgent(a.id, { planSelectionMode: 'least-covered' });
    updateAgent(a.id, { displayName: 'Renamed' });
    const reread = getAgent(a.id)!;
    expect(reread.displayName).toBe('Renamed');
    expect(reread.planSelectionMode).toBe('least-covered');
  });

  it('can switch back to "fixed"', () => {
    const a = createAgent({ repoId, name: 'qa-hunter' });
    updateAgent(a.id, { planSelectionMode: 'least-covered' });
    updateAgent(a.id, { planSelectionMode: 'fixed' });
    expect(getAgent(a.id)!.planSelectionMode).toBe('fixed');
  });
});
