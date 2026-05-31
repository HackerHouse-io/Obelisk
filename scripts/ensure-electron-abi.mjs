#!/usr/bin/env node
// Ensure native modules (better-sqlite3, keytar) are compiled for Electron's
// Node ABI before launching dev / build / preview.
//
// Why this exists: `pnpm test` runs `npm rebuild` against the system Node
// (vitest needs that), and `posttest` is supposed to put things back. But
// `posttest` doesn't fire on Ctrl+C, on a hard crash, or when someone runs
// `pnpm exec vitest` directly. The next `pnpm dev` then crashes with a
// "NODE_MODULE_VERSION" mismatch because Electron's V8 is on a different ABI
// than the system Node.
//
// How we detect it: probe the module by loading it under ELECTRON ITSELF —
// the exact runtime that will dlopen it at launch. Probing under the *system*
// Node is unreliable: the dev default may be Node 20, 22, or 24 (ABIs 115 /
// 127 / 137), none of which match Electron's ABI (130). A module built for
// Node 22 and a module built for Electron BOTH throw the same
// NODE_MODULE_VERSION error under Node 24, so a system-Node probe can't tell
// "still wrong" from "already correct" and wrongly skips the rebuild. Loading
// under Electron removes the ambiguity: it succeeds iff the ABI is right.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function rebuild(reason) {
  console.log(`[obelisk] ${reason} — rebuilding native modules for Electron…`);
  // Use `electron-rebuild -f` (force), NOT `electron-builder install-app-deps`:
  // the latter delegates to @electron/rebuild WITHOUT forcing, so it sees an
  // existing build for the module version and SKIPS — reporting "finished"
  // while leaving the wrong-ABI .node in place. `-f` always recompiles.
  const r = spawnSync(
    'pnpm',
    ['exec', 'electron-rebuild', '-f', '-m', '.', '-o', 'better-sqlite3,keytar'],
    { cwd: root, stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
}

// The `electron` package's main export is the absolute path to the binary.
let electronBin;
try {
  electronBin = require('electron');
} catch {
  electronBin = null;
}
if (typeof electronBin !== 'string') {
  // Can't locate Electron — rebuild defensively rather than launch a broken app.
  rebuild('could not locate the Electron binary');
}

// Run Electron as a plain Node (ELECTRON_RUN_AS_NODE) so it loads the .node
// file under Electron's V8 ABI. Instantiating a Database forces the lazy
// dlopen so an ABI mismatch surfaces as a non-zero exit.
const probe = spawnSync(
  electronBin,
  ['-e', "new (require('better-sqlite3'))(':memory:').close();"],
  { cwd: root, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
);

if (probe.status === 0) {
  // Loads cleanly under Electron's ABI — nothing to do (happy path).
  process.exit(0);
}

const stderr = probe.stderr ?? '';
if (/NODE_MODULE_VERSION/.test(stderr)) {
  rebuild('native modules built for the wrong ABI');
}
if (/Cannot find module/.test(stderr)) {
  rebuild('native modules missing');
}

console.error('[obelisk] could not probe native modules under Electron:');
console.error((stderr || String(probe.error ?? 'unknown error')).slice(0, 1000));
process.exit(probe.status ?? 1);
