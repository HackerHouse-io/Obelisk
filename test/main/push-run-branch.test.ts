import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { pushRunBranch } from '../../src/main/publisher/push-run-branch';
import { ObeliskError } from '../../src/shared/errors';

let tmp: string;
let workDir: string;
let originDir: string;
let work: SimpleGit;

async function initWorkRepoWithRemote(): Promise<void> {
  originDir = join(tmp, 'origin.git');
  mkdirSync(originDir, { recursive: true });
  await simpleGit(originDir).raw(['init', '--bare', '--initial-branch=main']);

  workDir = join(tmp, 'work');
  mkdirSync(workDir, { recursive: true });
  work = simpleGit(workDir);
  await work.raw(['init', '--initial-branch=main']);
  await work.addConfig('user.email', 'test@example.com');
  await work.addConfig('user.name', 'Test');
  await work.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(workDir, 'README.md'), '# work\n');
  await work.add('.');
  await work.commit('initial');
  await work.raw(['remote', 'add', 'origin', originDir]);
  await work.raw(['checkout', '-b', 'obelisk/run-1']);
}

/** Install a pre-push hook that always fails — mimics a husky hook running
 *  `vitest` in a worktree with no node_modules. */
function installFailingPrePushHook(): void {
  const hook = join(workDir, '.git', 'hooks', 'pre-push');
  writeFileSync(
    hook,
    '#!/bin/sh\necho "Running frontend tests before push..." >&2\nexit 1\n',
    'utf8',
  );
  chmodSync(hook, 0o755);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-push-'));
  await initWorkRepoWithRemote();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('pushRunBranch', () => {
  it('succeeds even when a failing pre-push hook is installed (the Bug Fixer bug)', async () => {
    installFailingPrePushHook();

    // Sanity: the hook really WOULD block a normal push.
    await expect(work.push(['--set-upstream', 'origin', 'obelisk/run-1'])).rejects.toBeTruthy();

    // Our push bypasses the local hook → lands on origin.
    await pushRunBranch(work, 'obelisk/run-1');
    const ref = await simpleGit(originDir).raw(['rev-parse', '--verify', 'obelisk/run-1']);
    expect(ref.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('pushes cleanly when there is no hook', async () => {
    await pushRunBranch(work, 'obelisk/run-1');
    const ref = await simpleGit(originDir).raw(['rev-parse', '--verify', 'obelisk/run-1']);
    expect(ref.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('surfaces a SERVER-side rejection as PUSH_REJECTED (not bypassed by --no-verify)', async () => {
    // A pre-receive hook lives on the remote; --no-verify can't skip it.
    const hook = join(originDir, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "pre-receive hook declined" >&2\nexit 1\n', 'utf8');
    chmodSync(hook, 0o755);

    await expect(pushRunBranch(work, 'obelisk/run-1')).rejects.toMatchObject({
      code: 'PUSH_REJECTED',
    });
    await expect(pushRunBranch(work, 'obelisk/run-1')).rejects.toBeInstanceOf(ObeliskError);
  });
});
