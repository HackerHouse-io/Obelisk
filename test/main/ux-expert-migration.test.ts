import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent, listAgentsForRepo } from '../../src/main/db/agents';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-uxm-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const MIGRATION_017 = join(process.cwd(), 'db', 'migrations', '017_ux_expert_agent.sql');

describe('017_ux_expert_agent backfill', () => {
  it('adds a paused UI/UX Expert to a repo that lacks one', () => {
    // Simulate a repo connected before ux-expert shipped: create the repo and
    // its legacy agents, but NOT a ux-expert. (runMigrations already ran on an
    // empty DB, so the backfill was a no-op then.)
    const repo = createRepo({
      githubFullName: 'test/legacy',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    createAgent({ repoId: repo.id, name: 'qa-hunter' });
    createAgent({ repoId: repo.id, name: 'bug-fixer' });
    expect(listAgentsForRepo(repo.id).some((a) => a.name === 'ux-expert')).toBe(false);

    // Re-run the migration SQL (idempotent via NOT EXISTS) — now a repo exists.
    getDb().exec(readFileSync(MIGRATION_017, 'utf8'));

    const ux = listAgentsForRepo(repo.id).filter((a) => a.name === 'ux-expert');
    expect(ux).toHaveLength(1);
    expect(ux[0]!.displayName).toBe('UI/UX Expert');
    expect(ux[0]!.enabled).toBe(false);
    expect(ux[0]!.timeoutMs).toBe(45 * 60 * 1000);
    expect(ux[0]!.permissions).toMatchObject({
      readCode: true,
      runTests: true,
      createIssues: true,
      draftPrs: false,
      merge: false,
    });
  });

  it('is idempotent — a second run does not duplicate the agent', () => {
    const repo = createRepo({
      githubFullName: 'test/legacy2',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    const sql = readFileSync(MIGRATION_017, 'utf8');
    getDb().exec(sql);
    getDb().exec(sql);
    expect(listAgentsForRepo(repo.id).filter((a) => a.name === 'ux-expert')).toHaveLength(1);
  });
});
