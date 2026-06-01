import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkWorktreeDependencies } from '../../src/main/git/worktree';

let tmp: string;
let repo: string;
let wt: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-deps-'));
  repo = join(tmp, 'repo');
  wt = join(tmp, 'wt');
  // Source checkout with installed deps.
  mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'vitest', 'config.js'), 'module.exports={}\n');
  mkdirSync(join(repo, 'backend', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'venv', 'bin', 'python'), '#!/bin/sh\n');
  // Worktree is a checkout of tracked files only (backend/ exists, no venv).
  mkdirSync(join(wt, 'backend'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('linkWorktreeDependencies', () => {
  it('symlinks node_modules + backend/venv so the agent can run the suite', () => {
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);

    linkWorktreeDependencies(repo, wt);

    // node_modules is a symlink and resolves through to the source dep.
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, 'node_modules', 'vitest', 'config.js'))).toBe(true);
    // backend/venv is linked too (pytest needs it).
    expect(lstatSync(join(wt, 'backend', 'venv')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, 'backend', 'venv', 'bin', 'python'))).toBe(true);
  });

  it('does not clobber a real tracked dir of the same name', () => {
    // Worktree already has a real (tracked) node_modules-like dir — leave it.
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'real.txt'), 'tracked\n');

    linkWorktreeDependencies(repo, wt);

    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(wt, 'node_modules', 'real.txt'))).toBe(true);
  });

  it('is a no-op when the source checkout has no dependency dirs', () => {
    const bareRepo = join(tmp, 'bare');
    mkdirSync(bareRepo, { recursive: true });
    expect(() => linkWorktreeDependencies(bareRepo, wt)).not.toThrow();
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });
});
