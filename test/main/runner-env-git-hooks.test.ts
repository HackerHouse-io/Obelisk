import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerEnv } from '../../src/main/runners/env';

describe('runnerEnv — git hook disabling', () => {
  it('sets GIT_CONFIG_* to point core.hooksPath at an existing empty dir', () => {
    const env = runnerEnv();
    expect(env['GIT_CONFIG_COUNT']).toBe('1');
    expect(env['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    const dir = env['GIT_CONFIG_VALUE_0'];
    expect(dir).toBeTruthy();
    expect(existsSync(dir!)).toBe(true);
  });

  it("a husky-style pre-commit hook does NOT block a commit under the runner env", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'obelisk-hookenv-'));
    try {
      // Real repo whose pre-commit hook always fails (mimics lint-staged with
      // no node_modules in an ephemeral worktree).
      const git = (args: string[], env?: NodeJS.ProcessEnv) =>
        execFileSync('git', args, { cwd: tmp, env: env ?? process.env, stdio: 'pipe' });
      git(['init', '--initial-branch=main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['config', 'commit.gpgsign', 'false']);
      const hooks = join(tmp, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const preCommit = join(hooks, 'pre-commit');
      writeFileSync(preCommit, '#!/bin/sh\nexit 1\n', 'utf8');
      chmodSync(preCommit, 0o755);
      writeFileSync(join(tmp, 'a.txt'), 'hello\n');
      git(['add', '.']);

      // Without the runner env the hook blocks the commit.
      expect(() => git(['commit', '-m', 'blocked'])).toThrow();

      // With the runner env (GIT_CONFIG_* disabling hooks) the commit succeeds.
      const env = { ...process.env, ...runnerEnv() };
      expect(() => git(['commit', '-m', 'allowed'], env)).not.toThrow();
      const log = git(['log', '--oneline'], env).toString();
      expect(log).toContain('allowed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
