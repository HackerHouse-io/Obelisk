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

export interface SeedBacklogInput {
  source?: 'manual' | 'gh_issue';
  /** Required when source is 'gh_issue'. */
  githubIssue?: number;
  title: string;
  kind: 'bug' | 'feature';
  priorityLabel?: 'P0' | 'P1' | 'P2' | null;
  /** Optional pin rank — lower wins over priority. */
  userPinRank?: number | null;
}

export interface SeedBacklogRow {
  id: string;
  title: string;
  kind: 'bug' | 'feature';
  priorityLabel: 'P0' | 'P1' | 'P2' | null;
  source: 'manual' | 'gh_issue';
  githubIssue: number | null;
}

export interface SeedIosQaPilotInput {
  /** Flow files to write under `<repo>/qa/ios-flows/`. */
  flows: { fileName: string; title: string; priority?: 'P0' | 'P1' | 'P2'; body?: string }[];
  /** Set `qa_ios_repo_state.setup_at` to a fresh ISO timestamp. */
  setupDone?: boolean;
  /** Number of pre-seeded sim slots in `qa_ios_sim_slots`. */
  simSlots?: number;
  /** Override the contents of `qa/ios.yml`. Defaults to a sane fixture. */
  iosYml?: string;
  /**
   * Skip writing `qa/ios.yml` entirely. Use this to reproduce the user-facing
   * "Setup healthy but Run now refuses" disconnect: every environment check
   * is green, but the per-repo config file is missing so dispatch refuses.
   */
  omitIosYml?: boolean;
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
  /**
   * Number of additional instances per agent type. Useful for multi-instance
   * agents (bug-fixer, feature-builder, ios-qa-pilot, pr-reviewer) when a test
   * needs to assert on parallelism, naming, etc. Defaults to 1.
   */
  agentCounts?: Partial<Record<SeedAgent['name'], number>>;
  /** Each instance is enabled by default unless this is false. */
  agentsEnabled?: boolean;
  previews?: {
    agentName: SeedAgent['name'];
    title: string;
    body: string;
    labels: string[];
  }[];
  /**
   * Backlog rows for `bug-fixer` / `feature-builder` to claim. Returned IDs
   * (in seed order) let tests assert exactly which row got picked.
   */
  backlogItems?: SeedBacklogInput[];
  testPlans?: SeedTestPlanInput[];
  iosQaPilot?: SeedIosQaPilotInput;
}): {
  repo: SeedRepo;
  agents: SeedAgent[];
  previews: SeedPreview[];
  backlog: SeedBacklogRow[];
} {
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
  const enabledFlag = opts.agentsEnabled === false ? 0 : 0; // default: disabled (matches prior behaviour)
  for (const name of opts.agents ?? ['qa-hunter']) {
    const copies = Math.max(1, opts.agentCounts?.[name] ?? 1);
    for (let i = 0; i < copies; i++) {
      const agentId = ulid();
      const display = i === 0 ? agentDisplayNameFor(name) : `${agentDisplayNameFor(name)} ${i + 1}`;
      // Bug Fixer / Feature Builder need draft_prs=1 so the run row's
      // permission audit reflects what's actually exercised by the test.
      const draftPrs = name === 'bug-fixer' || name === 'feature-builder' ? 1 : 0;
      db.prepare(
        `INSERT INTO agents (
          id, repo_id, name, display_name, enabled, runner_override, model_override,
          schedule_cron, schedule_json, timeout_ms,
          perm_read_code, perm_run_tests, perm_create_issues, perm_draft_prs, perm_merge,
          created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1, 1, 1, ?, 0, ?)`,
      ).run(agentId, repoId, name, display, enabledFlag, 30 * 60 * 1000, draftPrs, now);
      agents.push({ id: agentId, repoId, name, displayName: display });
    }
  }

  const backlog: SeedBacklogRow[] = [];
  for (const item of opts.backlogItems ?? []) {
    const id = ulid();
    const source = item.source ?? 'manual';
    const ghIssue = source === 'gh_issue' ? (item.githubIssue ?? null) : null;
    db.prepare(
      `INSERT INTO backlog
        (id, repo_id, source, github_issue, title, kind,
         priority_label, user_pin_rank, agent_override, runner_override,
         in_progress_run, added_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      repoId,
      source,
      ghIssue,
      item.title,
      item.kind,
      item.priorityLabel ?? null,
      item.userPinRank ?? null,
      now,
      now,
    );
    backlog.push({
      id,
      title: item.title,
      kind: item.kind,
      priorityLabel: item.priorityLabel ?? null,
      source,
      githubIssue: ghIssue,
    });
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
      .prepare(`INSERT INTO audit_log (run_id, at, kind, payload) VALUES (?, ?, 'preview', ?)`)
      .run(runId, now, payload);
    previews.push({ id: Number(info.lastInsertRowid), runId, repoId });
  }

  // Optionally seed iOS QA Pilot fixtures: qa/ios.yml + flows on disk,
  // plus setup_at + simulator slots in the DB. This skips the real
  // Doctor (which requires Xcode + Appium) so tests can exercise the
  // selectTask/runAgent path against a healthy iOS QA Pilot baseline.
  if (opts.iosQaPilot) {
    seedIosQaPilot(opts.repoLocalPath, repoId, opts.iosQaPilot, db);
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
    backlog,
  };
}

function seedIosQaPilot(
  repoLocalPath: string,
  repoId: string,
  cfg: SeedIosQaPilotInput,
  db: DatabaseSync,
): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const flowsDir = join(repoLocalPath, 'qa', 'ios-flows');
  fs.mkdirSync(flowsDir, { recursive: true });

  fs.mkdirSync(join(repoLocalPath, 'qa'), { recursive: true });
  if (!cfg.omitIosYml) {
    const yml =
      cfg.iosYml ??
      [
        'app_path: build/Debug-iphonesimulator/Fixture.app',
        'bundle_id: com.example.fixture',
        'simulator_device: iPhone 15',
        'max_parallel: 2',
        'appium_port_base: 4723',
        'wda_port_base: 8100',
        'flows_dir: qa/ios-flows',
        '',
      ].join('\n');
    fs.writeFileSync(join(repoLocalPath, 'qa', 'ios.yml'), yml, 'utf8');
  }

  for (const f of cfg.flows) {
    const body = f.body ?? '# Steps\n1. Tap something.\n2. Verify it.\n';
    const fm = [
      '---',
      `title: ${f.title}`,
      `priority: ${f.priority ?? 'P1'}`,
      '---',
      '',
      body,
    ].join('\n');
    fs.writeFileSync(join(flowsDir, f.fileName), fm, 'utf8');
  }

  if (cfg.setupDone) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO qa_ios_repo_state (repo_id, cycle, setup_at) VALUES (?, 0, ?)
       ON CONFLICT(repo_id) DO UPDATE SET setup_at = excluded.setup_at`,
    ).run(repoId, now);
  }

  const slotCount = cfg.simSlots ?? 0;
  for (let i = 0; i < slotCount; i++) {
    db.prepare(
      `INSERT INTO qa_ios_sim_slots (slot_index, udid, appium_port, wda_port)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slot_index) DO NOTHING`,
    ).run(i, `e2e-fixture-udid-${i}`, 4723 + i, 8100 + i);
  }
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
      p.id ?? (p.scope === 'feature' && p.feature ? `feature-${slugify(p.feature)}` : 'full-app');
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
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'plan'
  );
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
