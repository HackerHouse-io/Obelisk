import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeFlowId,
  loadFlowsFromRepo,
  parseFrontmatter,
  syncFlowsToRegistry,
} from '../../../../src/main/agents/ios-qa-pilot/flows';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import { createRepo } from '../../../../src/main/db/repos';
import {
  getFlow,
  listFlows,
  listMigrationsForRepo,
} from '../../../../src/main/db/qa-flows';

let tmp: string;
let repoId: string;
let repoPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-flows-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoPath = join(tmp, 'repo');
  mkdirSync(join(repoPath, 'qa', 'ios-flows'), { recursive: true });
  const repo = createRepo({
    githubFullName: 'test/ios',
    localPath: repoPath,
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

function writeFlowFile(name: string, frontmatter: string, body: string): void {
  const path = join(repoPath, 'qa', 'ios-flows', name);
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}\n`);
}

describe('parseFrontmatter', () => {
  it('extracts title, priority, and tags', () => {
    const fm = parseFrontmatter('---\ntitle: Login\npriority: P0\ntags: [auth, smoke]\n---\n# body');
    expect(fm.title).toBe('Login');
    expect(fm.priority).toBe('P0');
    expect(fm.tags).toEqual(['auth', 'smoke']);
  });

  it('returns empty title when no frontmatter', () => {
    const fm = parseFrontmatter('# just body');
    expect(fm.title).toBe('');
  });
});

describe('loadFlowsFromRepo', () => {
  it('reads only *.flow.md files and builds parsed flows', () => {
    writeFlowFile('login.flow.md', 'title: Login', '# Steps\n1. Tap Sign in.');
    writeFlowFile('signup.flow.md', 'title: Signup', '# Steps\n1. Tap Create.');
    writeFileSync(join(repoPath, 'qa', 'ios-flows', 'README.md'), '# Not a flow file');

    const flows = loadFlowsFromRepo(repoPath, 'qa/ios-flows');
    expect(flows.map((f) => f.title).sort()).toEqual(['Login', 'Signup']);
  });

  it('returns [] when the directory does not exist', () => {
    expect(loadFlowsFromRepo(repoPath, 'qa/missing')).toEqual([]);
  });
});

describe('computeFlowId', () => {
  it('is stable across calls with the same path+title', () => {
    expect(computeFlowId('qa/ios-flows/login.flow.md', 'Login')).toBe(
      computeFlowId('qa/ios-flows/login.flow.md', 'Login'),
    );
  });

  it('changes when the title changes', () => {
    const a = computeFlowId('qa/ios-flows/login.flow.md', 'Login');
    const b = computeFlowId('qa/ios-flows/login.flow.md', 'Login (v2)');
    expect(a).not.toBe(b);
  });

  it('changes when the path changes', () => {
    const a = computeFlowId('qa/ios-flows/login.flow.md', 'Login');
    const b = computeFlowId('qa/ios-flows/auth/login.flow.md', 'Login');
    expect(a).not.toBe(b);
  });
});

describe('syncFlowsToRegistry', () => {
  it('inserts new flows as pending', () => {
    writeFlowFile('a.flow.md', 'title: A', 'body');
    const flows = loadFlowsFromRepo(repoPath, 'qa/ios-flows');
    syncFlowsToRegistry(repoId, flows);
    const rows = listFlows(repoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('demotes status to outdated when body changes (same id)', () => {
    writeFlowFile('a.flow.md', 'title: A', 'body v1');
    syncFlowsToRegistry(repoId, loadFlowsFromRepo(repoPath, 'qa/ios-flows'));

    // Pretend the flow was verified passed.
    const id = listFlows(repoId)[0]!.flowId;
    const db = require('better-sqlite3')(join(tmp, 'obelisk.sqlite'));
    db.prepare(`UPDATE qa_ios_flows SET status='passed' WHERE flow_id=?`).run(id);
    db.close();

    writeFlowFile('a.flow.md', 'title: A', 'body v2');
    syncFlowsToRegistry(repoId, loadFlowsFromRepo(repoPath, 'qa/ios-flows'));

    const row = getFlow(id);
    expect(row?.status).toBe('outdated');
  });

  it('migrates run history when a flow file is renamed (same body)', () => {
    writeFlowFile('a.flow.md', 'title: A', 'shared body content');
    syncFlowsToRegistry(repoId, loadFlowsFromRepo(repoPath, 'qa/ios-flows'));
    const oldRow = listFlows(repoId)[0]!;
    expect(oldRow).toBeTruthy();

    // Mark it as having a run history.
    const db = require('better-sqlite3')(join(tmp, 'obelisk.sqlite'));
    db.prepare(
      `UPDATE qa_ios_flows SET status='passed', last_run_id='run-old', last_verified_at='2020-01-01', finding_count=2 WHERE flow_id=?`,
    ).run(oldRow.flowId);
    db.close();

    // Rename the file (same body, new title).
    renameSync(
      join(repoPath, 'qa', 'ios-flows', 'a.flow.md'),
      join(repoPath, 'qa', 'ios-flows', 'b.flow.md'),
    );
    writeFlowFile('b.flow.md', 'title: B', 'shared body content');
    const flows = loadFlowsFromRepo(repoPath, 'qa/ios-flows');
    const migrations = syncFlowsToRegistry(repoId, flows);

    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.oldId).toBe(oldRow.flowId);

    const newRow = listFlows(repoId)[0]!;
    expect(newRow.title).toBe('B');
    expect(newRow.lastRunId).toBe('run-old');
    expect(newRow.findingCount).toBe(2);

    const audit = listMigrationsForRepo(repoId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.oldId).toBe(oldRow.flowId);
  });
});
