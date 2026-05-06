import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ulid } from 'ulid';

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(PROJECT_ROOT, 'db', 'migrations');

export interface SeedRepo {
  id: string;
  fullName: string;
  localPath: string;
}

export interface SeedAgent {
  id: string;
  repoId: string;
  name:
    | 'qa-hunter'
    | 'manual-qa'
    | 'ios-qa-pilot'
    | 'bug-fixer'
    | 'feature-builder'
    | 'pr-reviewer';
  displayName: string;
}

export interface SeedPreview {
  id: number;
  runId: string;
  repoId: string;
}

/**
 * Pre-populate a SQLite DB at `<userDataDir>/obelisk.sqlite` with a repo,
 * one or more agents, and (optionally) a previewed finding.
 *
 * Returns the IDs so tests can reference them. Runs all bundled SQL
 * migrations first so the schema matches what main/index.ts would build.
 */
export function seed(opts: {
  userDataDir: string;
  repoFullName?: string;
  repoLocalPath: string;
  mode?: 'observe' | 'issues' | 'prs' | 'automerge';
  agents?: SeedAgent['name'][];
  previews?: {
    agentName: SeedAgent['name'];
    title: string;
    body: string;
    labels: string[];
  }[];
  testPlans?: SeedTestPlanInput[];
}): { repo: SeedRepo; agents: SeedAgent[]; previews: SeedPreview[] } {
  mkdirSync(opts.userDataDir, { recursive: true });
  const dbPath = join(opts.userDataDir, 'obelisk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  applyMigrations(db);

  const repoId = ulid();
  const fullName = opts.repoFullName ?? 'obelisk-test/fixture';
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO repos (id, github_full_name, local_path, default_branch, mode, default_runner, connected_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, fullName, opts.repoLocalPath, 'main', opts.mode ?? 'observe', 'claude', now, now);

  const agents: SeedAgent[] = [];
  for (const name of opts.agents ?? ['qa-hunter']) {
    const agentId = ulid();
    db.prepare(
      `INSERT INTO agents (
        id, repo_id, name, display_name, enabled, runner_override, model_override,
        schedule_cron, schedule_json, timeout_ms,
        perm_read_code, perm_run_tests, perm_create_issues, perm_draft_prs, perm_merge,
        created_at
      ) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, 1, 1, 1, 0, 0, ?)`,
    ).run(agentId, repoId, name, agentDisplayNameFor(name), 30 * 60 * 1000, now);
    agents.push({ id: agentId, repoId, name, displayName: agentDisplayNameFor(name) });
  }

  const previews: SeedPreview[] = [];
  for (const p of opts.previews ?? []) {
    const ownerAgent = agents.find((a) => a.name === p.agentName);
    if (!ownerAgent) {
      throw new Error(`seed: cannot create preview for ${p.agentName} — agent not seeded`);
    }
    const runId = ulid();
    db.prepare(
      `INSERT INTO runs (
        id, repo_id, agent_name, agent_id, state, started_at, finished_at,
        last_heartbeat_at, trigger, task_ref, runner_used, fallback_used,
        output_summary, error_code, worktree_path
      ) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, 'manual', 'qa-sweep', 'claude', 0,
                'Previewed 1 finding (observe mode)', NULL, NULL)`,
    ).run(runId, repoId, p.agentName, ownerAgent.id, now, now, now);
    const payload = JSON.stringify({
      kind: 'issue',
      title: p.title,
      body: p.body,
      labels: p.labels,
    });
    const info = db
      .prepare(
        `INSERT INTO audit_log (run_id, at, kind, payload) VALUES (?, ?, 'preview', ?)`,
      )
      .run(runId, now, payload);
    previews.push({ id: Number(info.lastInsertRowid), runId, repoId });
  }

  db.close();

  // Optionally seed test plan markdown files into the fixture repo so the
  // run-button gate sees a plan and the editor can open something.
  if (opts.testPlans?.length) {
    seedTestPlanFiles(opts.repoLocalPath, opts.testPlans);
  }

  return {
    repo: { id: repoId, fullName, localPath: opts.repoLocalPath },
    agents,
    previews,
  };
}

interface SeedTestPlanInput {
  id?: string;
  agentName: SeedAgent['name'];
  scope?: 'whole-app' | 'feature';
  feature?: string;
  name?: string;
  cases?: number;
}

function seedTestPlanFiles(repoLocalPath: string, plans: SeedTestPlanInput[]): void {
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const dir = join(repoLocalPath, 'qa', 'test-plans');
  mkdirSync(dir, { recursive: true });
  for (const p of plans) {
    const id =
      p.id ??
      (p.scope === 'feature' && p.feature
        ? `feature-${slugify(p.feature)}`
        : 'full-app');
    const cases = Array.from({ length: p.cases ?? 2 }, (_, i) => i + 1)
      .map(
        (n) =>
          `- [ ] Case ${n}: do thing ${n}\n  - **Expected:** outcome ${n}\n  - **Repro:** click ${n}`,
      )
      .join('\n');
    const fm = [
      `id: ${id}`,
      `name: ${p.name ?? (p.scope === 'feature' && p.feature ? `${capitalize(p.feature)} sweep` : 'Full app sweep')}`,
      `scope: ${p.scope ?? 'whole-app'}`,
      `feature: ${p.feature ? p.feature : 'null'}`,
      `agentName: ${p.agentName}`,
      `generatedAt: ${new Date().toISOString()}`,
      `generatedBy: manual`,
      `version: 1`,
    ].join('\n');
    writeFileSync(join(dir, `${id}.md`), `---\n${fm}\n---\n\n## Smoke\n${cases}\n`, 'utf8');
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'plan';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    (db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(
        filename,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function agentDisplayNameFor(name: SeedAgent['name']): string {
  return {
    'qa-hunter': 'QA Hunter',
    'manual-qa': 'Manual QA',
    'ios-qa-pilot': 'iOS QA Pilot',
    'bug-fixer': 'Bug Fixer',
    'feature-builder': 'Feature Builder',
    'pr-reviewer': 'PR Reviewer',
  }[name];
}
