import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../../../src/main/db';
import { runMigrations } from '../../../../src/main/db/migrations';
import {
  allocateSimSlot,
  listSimSlots,
  releaseSimSlot,
  sweepStaleSimSlots,
  upsertSimSlot,
} from '../../../../src/main/db/qa-flows';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-pool-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function seedSlots(n: number): void {
  for (let i = 0; i < n; i++) {
    upsertSimSlot({
      slotIndex: i,
      udid: `udid-${i}`,
      appiumPort: 4723 + i,
      wdaPort: 8100 + i,
    });
  }
}

describe('allocateSimSlot', () => {
  it('returns null when no slots exist', () => {
    expect(allocateSimSlot('run-1')).toBeNull();
  });

  it('claims slots in slot_index order', () => {
    seedSlots(2);
    const a = allocateSimSlot('run-1');
    const b = allocateSimSlot('run-2');
    const c = allocateSimSlot('run-3');
    expect(a?.slotIndex).toBe(0);
    expect(b?.slotIndex).toBe(1);
    expect(c).toBeNull();
  });

  it('atomic under concurrent contention — exactly N callers get a slot for N slots', async () => {
    seedSlots(2);
    const wins = (
      await Promise.all([
        Promise.resolve(allocateSimSlot('run-1')),
        Promise.resolve(allocateSimSlot('run-2')),
        Promise.resolve(allocateSimSlot('run-3')),
        Promise.resolve(allocateSimSlot('run-4')),
      ])
    ).filter((s): s is NonNullable<typeof s> => s !== null);
    expect(wins).toHaveLength(2);
    expect(new Set(wins.map((s) => s.slotIndex)).size).toBe(wins.length);
  });
});

describe('releaseSimSlot', () => {
  it('makes the slot claimable again', () => {
    seedSlots(1);
    const claimed = allocateSimSlot('run-1')!;
    releaseSimSlot('run-1');
    const reclaimed = allocateSimSlot('run-2');
    expect(reclaimed?.slotIndex).toBe(claimed.slotIndex);
  });
});

describe('sweepStaleSimSlots', () => {
  it('releases slots whose claim is older than maxAgeMs', () => {
    seedSlots(1);
    allocateSimSlot('run-old');
    // Manually backdate the claim.
    const Database = require('better-sqlite3');
    const db = Database(join(tmp, 'obelisk.sqlite'));
    db.prepare(
      `UPDATE qa_ios_sim_slots SET claimed_at = '2000-01-01T00:00:00Z' WHERE claimed_run_id = 'run-old'`,
    ).run();
    db.close();

    const released = sweepStaleSimSlots(60_000);
    expect(released).toBe(1);
    expect(listSimSlots()[0]!.claimedRunId).toBeNull();
  });

  it('leaves recent claims alone', () => {
    seedSlots(1);
    allocateSimSlot('run-fresh');
    const released = sweepStaleSimSlots(60_000);
    expect(released).toBe(0);
    expect(listSimSlots()[0]!.claimedRunId).toBe('run-fresh');
  });
});
