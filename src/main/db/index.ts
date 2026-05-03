import { app } from 'electron';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database | null = null;
let overridePath: string | null = null;

/** Test-only: point the DB at a custom file. Must be called before getDb(). */
export function setDbPathForTesting(absolutePath: string): void {
  if (db) {
    db.close();
    db = null;
  }
  overridePath = absolutePath;
}

function resolveUserDataDir(): string {
  if (overridePath) {
    return overridePath.substring(0, overridePath.lastIndexOf('/')) || overridePath;
  }
  try {
    return app.getPath('userData');
  } catch {
    return join(process.cwd(), '.obelisk-test-data');
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  const path = overridePath ?? join(resolveUserDataDir(), 'obelisk.sqlite');
  const dir = path.substring(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function dbPath(): string {
  return overridePath ?? join(resolveUserDataDir(), 'obelisk.sqlite');
}
