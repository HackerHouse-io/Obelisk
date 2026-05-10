import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { collectPatch } from '../../src/main/runners/collect-patch';
import type { RunOpts } from '../../src/main/runners/types';

let worktree: string;

const STUB_PROMPT = {
  systemPrompt: 'sys',
  userMessage: 'user',
  attachments: [],
  runnerArgs: [],
  contentHash: 'h',
};

function makeOpts(overrides: Partial<RunOpts> = {}): RunOpts {
  return {
    worktreePath: worktree,
    prompt: STUB_PROMPT,
    timeoutMs: 1000,
    onAudit: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  worktree = mkdtempSync(join(tmpdir(), 'obelisk-collect-patch-'));
  const git = simpleGit(worktree);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(worktree, 'README.md'), '# seed\n');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['branch', '-M', 'main']);
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('collectPatch', () => {
  it('returns the staged diff when the agent left unstaged edits', async () => {
    writeFileSync(join(worktree, 'src.txt'), 'hello\n');

    const result = await collectPatch(makeOpts(), 'agent reasoning');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.filesChanged).toEqual(['src.txt']);
    expect(result.patch.diff).toContain('+hello');
    expect(result.reasoning).toBe('agent reasoning');
  });

  it('falls back to baseRef..HEAD when the agent committed everything (Bug Fixer Prove-It)', async () => {
    // Capture the baseRef BEFORE the agent's commits, then have the
    // "agent" land its work as two commits — Bug Fixer's prove-it
    // pattern (failing test commit + fix commit).
    const git = simpleGit(worktree);
    const baseRef = (await git.revparse(['HEAD'])).trim();

    mkdirSync(join(worktree, 'auth'), { recursive: true });
    writeFileSync(join(worktree, 'auth', 'session.test.ts'), '// failing test\n');
    await git.add('.');
    await git.commit('test: failing repro [obelisk:bug-fixer]');

    writeFileSync(join(worktree, 'auth', 'session.ts'), '// fix\n');
    await git.add('.');
    await git.commit('fix: resolve issue [obelisk:bug-fixer]');

    const result = await collectPatch(makeOpts({ baseRef }), 'agent reasoning');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.filesChanged.sort()).toEqual([
      'auth/session.test.ts',
      'auth/session.ts',
    ]);
    expect(result.patch.diff).toContain('+// failing test');
    expect(result.patch.diff).toContain('+// fix');
  });

  it('returns no_changes when neither staged nor committed work exists', async () => {
    const baseRef = (await simpleGit(worktree).revparse(['HEAD'])).trim();

    const result = await collectPatch(makeOpts({ baseRef }), 'no-op reasoning');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_changes');
    expect(result.reasoning).toBe('no-op reasoning');
  });

  it('returns no_changes when baseRef is missing and the agent committed everything', async () => {
    // Without the orchestrator-provided baseRef the runner cannot detect
    // committed work. This documents the safety floor: the no-baseRef
    // path returns no_changes (the orchestrator always passes baseRef in
    // production; this test only protects against a future regression
    // where it stops doing so).
    const git = simpleGit(worktree);
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    await git.add('.');
    await git.commit('only commit');

    const result = await collectPatch(makeOpts(), 'reasoning');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_changes');
  });
});
