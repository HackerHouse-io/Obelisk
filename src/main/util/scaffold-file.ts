import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Idempotent file scaffold: writes `body` to `path` only when no file
 * is already there. Creates parent directories as needed. Returns true
 * when a new file was written, false when the path already existed
 * (the existing content is left untouched).
 *
 * Used by per-project setup helpers (`qa/ios.yml`, default flow files,
 * agent memory files) where we want to seed a starter file once and
 * never clobber the user's edits.
 */
export function scaffoldFile(path: string, body: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return true;
}
