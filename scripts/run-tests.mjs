#!/usr/bin/env node
// Wrap vitest so the rebuild dance always completes. The previous
// pretest/posttest pair left native modules at Node's ABI when tests were
// killed (Ctrl+C, crash, OOM) — `pnpm dev` would then refuse to launch.
//
// Sequence:
//   1. Rebuild better-sqlite3 + keytar against the system Node so vitest can
//      load them.
//   2. Run vitest with whatever args the caller passed; capture exit code.
//   3. ALWAYS rebuild for Electron afterwards — including on test failure or
//      signal exit — so the next `pnpm dev` boots cleanly.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

// 1) Rebuild for system Node so vitest can load native modules.
const preStatus = runSync('npm', ['rebuild', 'better-sqlite3', 'keytar']);
if (preStatus !== 0) {
  // Almost always a Node-version problem: better-sqlite3 ships prebuilt
  // binaries only for the maintained LTS lines. On a too-new Node (e.g. 24),
  // prebuild-install finds nothing and falls back to compiling from source —
  // which dies on macOS's ancient GNU Make 3.81 with a cryptic ".deps ...
  // No such file or directory" gyp dump. The supported runtime is pinned in
  // .nvmrc / package.json "engines"; surface that instead of the raw error.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.error('\n[obelisk] Could not build native modules (better-sqlite3 / keytar) for Node.');
  if (Number.isFinite(nodeMajor) && nodeMajor >= 23) {
    console.error(
      `[obelisk] You're on Node ${process.versions.node}, which has no prebuilt better-sqlite3 ` +
        `binary and can't be compiled here. Use the supported LTS:\n` +
        `[obelisk]     nvm use 22   (see .nvmrc)\n` +
        `[obelisk] then re-run. To make it stick: nvm alias default 22`,
    );
  }
  process.exit(preStatus);
}

// 2) Run vitest. Use spawn (not spawnSync) so we can forward signals cleanly.
const vitestArgs = process.argv.includes('--watch') ? [] : ['run'];
const userArgs = process.argv.slice(2).filter((a) => a !== '--watch');
const test = spawn('pnpm', ['exec', 'vitest', ...vitestArgs, ...userArgs], {
  cwd: root,
  stdio: 'inherit',
});

const cleanup = (code) => {
  // 3) Rebuild for Electron so subsequent `pnpm dev` works. Best-effort —
  //    we keep the test exit code regardless.
  spawnSync('pnpm', ['exec', 'electron-builder', 'install-app-deps'], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(code);
};

test.on('exit', (code, signal) => {
  cleanup(signal ? 1 : (code ?? 0));
});

// Forward Ctrl+C / SIGTERM to vitest so its own teardown fires; cleanup
// runs from the `exit` handler above.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!test.killed) test.kill(sig);
  });
}
