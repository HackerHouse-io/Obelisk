#!/usr/bin/env node
// Ensure native modules (better-sqlite3, keytar) are compiled for Electron's
// Node ABI before launching dev / build / preview.
//
// Why this exists: `pnpm test` runs `npm rebuild` against the system Node
// (vitest needs that), and `posttest` is supposed to put things back. But
// `posttest` doesn't fire on Ctrl+C, on a hard crash, or when someone runs
// `pnpm exec vitest` directly. The next `pnpm dev` then crashes with
// "NODE_MODULE_VERSION 137 vs 130" because Electron's V8 is on a different
// ABI than the system Node.
//
// The fix: probe the module from a Node child process. If `require` succeeds
// the module is at the wrong ABI for Electron — rebuild. If `require` fails
// with NODE_MODULE_VERSION the module is already at Electron's ABI — fast
// path, exit silently. Total cost on the happy path: ~30ms.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Note: `require('better-sqlite3')` only loads the JS wrapper — the `.node`
// file is dlopened lazily on first use. We instantiate a Database to force
// the dlopen so the ABI mismatch surfaces as an exception we can detect.
const probe = spawnSync(
  process.execPath,
  ['-e', "new (require('better-sqlite3'))(':memory:').close();"],
  { cwd: root, encoding: 'utf8' },
);

if (probe.status === 0) {
  console.log('[obelisk] native modules built for Node ABI — rebuilding for Electron…');
  const rebuild = spawnSync('pnpm', ['exec', 'electron-builder', 'install-app-deps'], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(rebuild.status ?? 1);
}

if (/NODE_MODULE_VERSION/.test(probe.stderr)) {
  process.exit(0);
}

if (/Cannot find module/.test(probe.stderr)) {
  console.log('[obelisk] native modules missing — installing for Electron…');
  const rebuild = spawnSync('pnpm', ['exec', 'electron-builder', 'install-app-deps'], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(rebuild.status ?? 1);
}

console.error('[obelisk] could not probe native modules:');
console.error(probe.stderr.slice(0, 1000));
process.exit(probe.status ?? 1);
