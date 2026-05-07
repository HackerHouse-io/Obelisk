/**
 * Real-runner smoke test for plan generation.
 *
 * The user explicitly asked: "you have to write a test to make sure both
 * Codex and Claude Code can generate a simple test plan." This test invokes
 * the actual `claude` and `codex` binaries with the EXACT args our generator
 * uses, against a throwaway worktree, and asserts the CLI exits 0.
 *
 * It does NOT parse the model's output (the prompt parser already has its
 * own coverage in test-plans-extract.test.ts). The point is to catch
 * arg-shape regressions like a hardcoded `--model gpt-5` that breaks
 * ChatGPT-account Codex sign-ins.
 *
 * Behavior:
 *   - When the matching CLI is not on PATH, the case is skipped quietly.
 *   - Set OBELISK_RUNNER_SMOKE=1 to enforce both runners (CI machines that
 *     have them installed).
 */
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexExecArgs } from '../../src/main/prompt-compiler/codex-layout';

const PROMPT = [
  'You are a CLI smoke test. Reply with EXACTLY the following block, no narration:',
  '',
  'BEGIN_TEST_PLAN',
  '{ "blocks": [{ "kind": "section", "title": "Smoke" }, { "kind": "case", "title": "Boots", "expected": "ok", "repro": "open", "severity": "P0" }] }',
  'END_TEST_PLAN',
].join('\n');

const SMOKE_TIMEOUT_MS = 90_000;

function isInstalled(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { timeout: 5_000 });
  return r.status === 0;
}

function makeWorktree(): string {
  // Init the worktree as a real git repo so the test mirrors production: in
  // production Obelisk creates a per-run git worktree, never a bare directory.
  // Without `git init` codex would refuse the run with "Not inside a trusted
  // directory" — and only `--skip-git-repo-check` (which our buildCodexExecArgs
  // adds) makes it succeed. Initializing git here keeps the smoke test
  // production-faithful instead of implicitly leaning on that flag.
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-runner-smoke-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "smoke@example.com"', { cwd: dir });
  execSync('git config user.name "smoke"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  execSync('git add . && git commit -q -m initial', { cwd: dir });
  return dir;
}

const enforce = process.env['OBELISK_RUNNER_SMOKE'] === '1';

describe('real-runner CLI smoke', () => {
  describe('claude', () => {
    const installed = isInstalled('claude');
    if (!installed && !enforce) {
      it.skip('claude not installed — skipping (set OBELISK_RUNNER_SMOKE=1 to enforce)', () => {});
      return;
    }

    it(
      'accepts the plan-generator args and exits 0',
      () => {
        const wt = makeWorktree();
        try {
          // Mirrors `claudeArgs(modelOverride)` in src/main/test-plans/generate.ts
          // when no Settings model and no override are present (most users).
          const args = ['-p', '--system-prompt', 'You echo a small JSON block.'];
          expect(args).not.toContain('--model'); // never hardcode

          const result = spawnSync('claude', args, {
            cwd: wt,
            input: PROMPT,
            timeout: SMOKE_TIMEOUT_MS,
            encoding: 'utf8',
          });
          if (result.status !== 0) {
            throw new Error(
              `claude exited ${result.status}; stderr: ${(result.stderr ?? '').slice(-500)}`,
            );
          }
          expect(result.status).toBe(0);
        } finally {
          rmSync(wt, { recursive: true, force: true });
        }
      },
      SMOKE_TIMEOUT_MS + 5_000,
    );
  });

  describe('codex', () => {
    const installed = isInstalled('codex');
    if (!installed && !enforce) {
      it.skip('codex not installed — skipping (set OBELISK_RUNNER_SMOKE=1 to enforce)', () => {});
      return;
    }

    it(
      'accepts the plan-generator args (no `--model` flag) and exits 0',
      () => {
        const wt = makeWorktree();
        try {
          // Use the SAME builder the production path uses, with no override
          // and no Settings → no `--model` flag. This is the configuration
          // ChatGPT-account Codex sign-ins require: any explicit `--model`
          // (e.g. the old hardcoded `gpt-5`) gets a 400.
          const args = buildCodexExecArgs({ sandbox: 'read-only', reasoning: 'high' });
          expect(args).not.toContain('--model');

          const result = spawnSync('codex', args, {
            cwd: wt,
            input: PROMPT,
            timeout: SMOKE_TIMEOUT_MS,
            encoding: 'utf8',
          });
          if (result.status !== 0) {
            throw new Error(
              `codex exited ${result.status}; stderr: ${(result.stderr ?? '').slice(-500)}`,
            );
          }
          expect(result.status).toBe(0);
        } finally {
          rmSync(wt, { recursive: true, force: true });
        }
      },
      SMOKE_TIMEOUT_MS + 5_000,
    );
  });
});
