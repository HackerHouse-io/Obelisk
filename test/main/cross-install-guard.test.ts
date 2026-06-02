import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { _resetSystemSentinelCacheForTesting } from '../../src/main/logger/audit';
import {
  hasClaimSignature,
  classifyClaimOwnership,
} from '../../src/main/agents/lib/cross-install-guard';

// The claim signature an Obelisk install writes when it picks up a task.
const SIGNED = {
  labels: ['obelisk:in-progress', 'p1'],
  assignees: ['obelisk-user'],
  connectedLogin: 'obelisk-user',
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-xinstall-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  _resetSystemSentinelCacheForTesting();
  runMigrations();
  // The audit module attaches its `runs.id = 'system'` sentinel to an existing
  // repo; without one, system-scope audits are silently dropped.
  createRepo({
    githubFullName: 'test/x',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'prs',
    defaultRunner: 'claude',
  });
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function auditKinds(): string[] {
  return getDb()
    .prepare<[], { kind: string }>(`SELECT kind FROM audit_log ORDER BY id`)
    .all()
    .map((r) => r.kind);
}

describe('hasClaimSignature', () => {
  it('is true only when the in-progress label AND a self-assignee are both present', () => {
    expect(hasClaimSignature(SIGNED)).toBe(true);
  });

  it('is false when not signed in (no connected login to compare against)', () => {
    expect(hasClaimSignature({ ...SIGNED, connectedLogin: null })).toBe(false);
  });

  it('is false when the in-progress label is absent', () => {
    expect(hasClaimSignature({ ...SIGNED, labels: ['p1'] })).toBe(false);
  });

  it('is false when the connected user is not in the assignees (someone else owns it)', () => {
    expect(hasClaimSignature({ ...SIGNED, assignees: ['other-user'] })).toBe(false);
  });
});

describe('classifyClaimOwnership', () => {
  it('returns "unclaimed" with no audit when there is no claim signature', () => {
    const out = classifyClaimOwnership({
      ...SIGNED,
      labels: ['p1'],
      source: 'issue#1',
      hasLocalRun: false,
    });
    expect(out).toBe('unclaimed');
    expect(auditKinds()).not.toContain('cross_install_skipped');
    expect(auditKinds()).not.toContain('self_claim_recovered');
  });

  it('returns "self" and audits self_claim_recovered when a local run row exists', () => {
    // Same install, leftover claim from a prior run that crashed/failed —
    // the per-install runs table proves it's ours, so we recover instead of
    // mislabeling it a sibling install.
    const out = classifyClaimOwnership({
      ...SIGNED,
      source: 'issue#1',
      hasLocalRun: true,
    });
    expect(out).toBe('self');
    expect(auditKinds()).toContain('self_claim_recovered');
    expect(auditKinds()).not.toContain('cross_install_skipped');
  });

  it('returns "foreign" and audits cross_install_skipped when no local run exists', () => {
    // Signature present but this install has never run the task → another
    // install (same GitHub user, different machine) genuinely owns it.
    const out = classifyClaimOwnership({
      ...SIGNED,
      source: 'issue#1',
      hasLocalRun: false,
    });
    expect(out).toBe('foreign');
    expect(auditKinds()).toContain('cross_install_skipped');
    expect(auditKinds()).not.toContain('self_claim_recovered');
  });
});
