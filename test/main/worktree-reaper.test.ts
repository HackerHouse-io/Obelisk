import { describe, it, expect } from 'vitest';
import { parseWorktreeList } from '../../src/main/scheduler/worktree-reaper';

describe('parseWorktreeList', () => {
  it('parses a single worktree block', () => {
    const raw = [
      'worktree /tmp/obelisk/abc/01HXYZ',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/obelisk/01HXYZ',
      '',
    ].join('\n');
    const out = parseWorktreeList(raw);
    expect(out).toEqual([{ path: '/tmp/obelisk/abc/01HXYZ', branch: 'obelisk/01HXYZ' }]);
  });

  it('parses multiple blocks separated by blank lines', () => {
    const raw = [
      'worktree /repo',
      'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /tmp/wt-1',
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'branch refs/heads/obelisk/run-one',
      '',
      'worktree /tmp/wt-2',
      'HEAD cccccccccccccccccccccccccccccccccccccccc',
      'branch refs/heads/obelisk/run-two',
    ].join('\n');
    const out = parseWorktreeList(raw);
    expect(out).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/tmp/wt-1', branch: 'obelisk/run-one' },
      { path: '/tmp/wt-2', branch: 'obelisk/run-two' },
    ]);
  });

  it('skips blocks that lack a branch (detached HEAD)', () => {
    const raw = [
      'worktree /tmp/detached',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'detached',
      '',
      'worktree /tmp/wt-1',
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'branch refs/heads/obelisk/run-one',
    ].join('\n');
    const out = parseWorktreeList(raw);
    expect(out).toEqual([{ path: '/tmp/wt-1', branch: 'obelisk/run-one' }]);
  });

  it('returns empty array when input is empty', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
