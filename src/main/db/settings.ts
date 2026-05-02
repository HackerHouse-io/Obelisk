import { getDb } from './index';

interface SettingRow {
  scope: string;
  key: string;
  value: string;
}

export type SettingScope = 'app' | `repo:${string}`;

export function getSetting<T>(scope: SettingScope, key: string): T | null {
  const row = getDb()
    .prepare<[string, string], SettingRow>('SELECT * FROM settings WHERE scope = ? AND key = ?')
    .get(scope, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(scope: SettingScope, key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    )
    .run(scope, key, JSON.stringify(value));
}

export function deleteSetting(scope: SettingScope, key: string): void {
  getDb().prepare('DELETE FROM settings WHERE scope = ? AND key = ?').run(scope, key);
}

export function listSettings(scope: SettingScope): Record<string, unknown> {
  const rows = getDb()
    .prepare<[string], SettingRow>('SELECT * FROM settings WHERE scope = ?')
    .all(scope);
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      // skip malformed
    }
  }
  return out;
}
