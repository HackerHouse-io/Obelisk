import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { setSetting } from '../../src/main/db/settings';
import { assertPatchAgentCap } from '../../src/main/ipc/agents';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-cap-preflight-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repoId = createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Manual Run-now used to bypass the per-repo bug-fixer cap entirely —
 * the 4th click would land in selectTask, find every backlog item
 * locked by an in-flight run, and surface "No claimable issue right now"
 * which doesn't actually explain what happened. This pre-flight throws
 * a categorized error before the run row is created so the renderer
 * can show the cap message.
 */
describe('assertPatchAgentCap (manual Run-now pre-flight)', () => {
  it('allows the dispatch when liveCount is below the default cap of 3', () => {
    expect(() => assertPatchAgentCap(repoId, 'bug-fixer', 'Bug Fixer', 0)).not.toThrow();
    expect(() => assertPatchAgentCap(repoId, 'bug-fixer', 'Bug Fixer', 2)).not.toThrow();
  });

  it('rejects with PATCH_AGENT_CAP_REACHED at the cap', () => {
    expect(() => assertPatchAgentCap(repoId, 'bug-fixer', 'Bug Fixer', 3)).toThrowError(
      expect.objectContaining({
        code: 'PATCH_AGENT_CAP_REACHED',
        message: expect.stringMatching(/3 Bug Fixers/),
        hint: expect.stringMatching(/Wait for one to finish/),
      }),
    );
  });

  it('honors the per-repo cap override', () => {
    setSetting(`repo:${repoId}`, 'bug_fixer_cap', 5);
    expect(() => assertPatchAgentCap(repoId, 'bug-fixer', 'Bug Fixer', 4)).not.toThrow();
    expect(() => assertPatchAgentCap(repoId, 'bug-fixer', 'Bug Fixer', 5)).toThrowError(
      expect.objectContaining({
        code: 'PATCH_AGENT_CAP_REACHED',
        message: expect.stringMatching(/5 Bug Fixers/),
      }),
    );
  });

  it("uses the agent type's plural noun in the message — 'Feature Builders' for feature-builder", () => {
    expect(() =>
      assertPatchAgentCap(repoId, 'feature-builder', 'Feature Builder', 3),
    ).toThrowError(/3 Feature Builders/);
  });
});
