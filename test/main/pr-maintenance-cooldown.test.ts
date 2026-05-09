import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { appendAudit, _resetSystemSentinelCacheForTesting } from '../../src/main/logger/audit';

let tmp: string;
let repoId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-prmaint-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  _resetSystemSentinelCacheForTesting();
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

/* Local copies of the predicates used inside auto-merge.ts. They're
 * private helpers and the tests verify the SQL shapes match what the
 * runtime queries expect. */
function countRebaseAttempts(prNumber: number): number {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_rebase_attempt'
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return row?.c ?? 0;
}

function hasPriorCiRetryAttempt(prNumber: number): boolean {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_ci_retry'
          AND json_extract(payload, '$.outcome') IN ('attempt','success','failed')
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return (row?.c ?? 0) > 0;
}

function hasPriorCiRetryEscalation(prNumber: number): boolean {
  const row = getDb()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'pr_ci_retry'
          AND json_extract(payload, '$.outcome') = 'escalated'
          AND json_extract(payload, '$.prNumber') = ?`,
    )
    .get(prNumber);
  return (row?.c ?? 0) > 0;
}

describe('pr_rebase_attempt cooldown queries', () => {
  it('countRebaseAttempts returns 0 when no audit rows for a PR', () => {
    expect(countRebaseAttempts(42)).toBe(0);
  });

  it('countRebaseAttempts counts only matching prNumber', () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 42, outcome: 'success' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 99, outcome: 'conflict' },
    });
    appendAudit({
      runId: 'system',
      kind: 'pr_rebase_attempt',
      payload: { prNumber: 42, outcome: 'conflict' },
    });
    expect(countRebaseAttempts(42)).toBe(2);
    expect(countRebaseAttempts(99)).toBe(1);
    expect(countRebaseAttempts(7)).toBe(0);
  });

  it('counts ignore unrelated audit kinds', () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 42, outcome: 'attempt' },
    });
    appendAudit({
      runId: 'system',
      kind: 'auto_merge_skipped',
      payload: { prNumber: 42, reason: 'dirty' },
    });
    expect(countRebaseAttempts(42)).toBe(0);
  });
});

describe('pr_ci_retry cooldown queries', () => {
  it('hasPriorCiRetryAttempt is false when no rows', () => {
    expect(hasPriorCiRetryAttempt(7)).toBe(false);
  });

  it('hasPriorCiRetryAttempt becomes true after any of attempt/success/failed', () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 7, outcome: 'attempt' },
    });
    expect(hasPriorCiRetryAttempt(7)).toBe(true);
  });

  it('escalated and aborted outcomes do not count toward "prior attempt"', () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 11, outcome: 'aborted' },
    });
    expect(hasPriorCiRetryAttempt(11)).toBe(false);
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 11, outcome: 'escalated' },
    });
    expect(hasPriorCiRetryAttempt(11)).toBe(false);
    expect(hasPriorCiRetryEscalation(11)).toBe(true);
  });

  it('hasPriorCiRetryEscalation is per-PR', () => {
    appendAudit({
      runId: 'system',
      kind: 'pr_ci_retry',
      payload: { prNumber: 1, outcome: 'escalated' },
    });
    expect(hasPriorCiRetryEscalation(1)).toBe(true);
    expect(hasPriorCiRetryEscalation(2)).toBe(false);
  });
});
