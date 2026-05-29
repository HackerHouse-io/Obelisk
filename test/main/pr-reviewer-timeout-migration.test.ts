import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent, getAgent } from '../../src/main/db/agents';

let tmp: string;
let repoId: string;

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'db', 'migrations', '013_pr_reviewer_timeout.sql'),
  'utf8',
);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-pr-timeout-'));
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

describe('013_pr_reviewer_timeout migration', () => {
  it('bumps pre-existing pr-reviewer rows from the old 10-min default to 30 min', () => {
    // Simulate an agent row created before the default was raised.
    const old = createAgent({
      repoId,
      name: 'pr-reviewer',
      displayName: 'Reviewer 1',
      timeoutMs: 600000,
    }).id;

    getDb().exec(MIGRATION_SQL);

    expect(getAgent(old)!.timeoutMs).toBe(1800000);
  });

  it('leaves a user-customized timeout untouched', () => {
    const custom = createAgent({
      repoId,
      name: 'pr-reviewer',
      displayName: 'Reviewer 2',
      timeoutMs: 900000,
    }).id;

    getDb().exec(MIGRATION_SQL);

    expect(getAgent(custom)!.timeoutMs).toBe(900000);
  });

  it('does not touch other agent types', () => {
    const bugFixer = createAgent({
      repoId,
      name: 'bug-fixer',
      displayName: 'Bug Fixer',
      timeoutMs: 600000,
    }).id;

    getDb().exec(MIGRATION_SQL);

    expect(getAgent(bugFixer)!.timeoutMs).toBe(600000);
  });

  it('new pr-reviewer agents already get the 30-min default', () => {
    const fresh = createAgent({ repoId, name: 'pr-reviewer', displayName: 'Reviewer 3' }).id;
    expect(getAgent(fresh)!.timeoutMs).toBe(1800000);
  });
});
