import { app } from 'electron';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './index';

/**
 * Apply pending SQL migrations from db/migrations/*.sql.
 * Each file is run inside a single transaction. We track the last applied
 * filename in the schema_migrations table so reapplying is safe.
 *
 * Resolution order for the migrations directory:
 *  1. <appResources>/db/migrations  (production: bundled with the asar)
 *  2. <projectRoot>/db/migrations    (development: repo source)
 */

function resolveMigrationsDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'db', 'migrations'),
    join(app.getAppPath(), 'db', 'migrations'),
    join(__dirname, '..', '..', '..', 'db', 'migrations'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(`migrations directory not found; tried: ${candidates.join(', ')}`);
}

export function runMigrations(): { applied: string[]; total: number } {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const dir = resolveMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const alreadyApplied = new Set(
    db
      .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
      .all()
      .map((r) => r.filename),
  );

  const applied: string[] = [];
  const apply = db.transaction((filename: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(
      filename,
      new Date().toISOString(),
    );
  });

  for (const filename of files) {
    if (alreadyApplied.has(filename)) continue;
    const sql = readFileSync(join(dir, filename), 'utf8');
    apply(filename, sql);
    applied.push(filename);
  }

  return { applied, total: files.length };
}
