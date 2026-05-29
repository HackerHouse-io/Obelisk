import { getDb } from './index';

export type QaFlowStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'outdated';

export interface QaFlowRow {
  flowId: string;
  repoId: string;
  title: string;
  sourcePath: string;
  bodySha: string;
  status: QaFlowStatus;
  cycle: number;
  claimedRunId: string | null;
  claimedAt: string | null;
  lastRunId: string | null;
  lastVerifiedAt: string | null;
  findingCount: number;
}

interface FlowDbRow {
  flow_id: string;
  repo_id: string;
  title: string;
  source_path: string;
  body_sha: string;
  status: QaFlowStatus;
  cycle: number;
  claimed_run_id: string | null;
  claimed_at: string | null;
  last_run_id: string | null;
  last_verified_at: string | null;
  finding_count: number;
}

function mapFlowRow(r: FlowDbRow): QaFlowRow {
  return {
    flowId: r.flow_id,
    repoId: r.repo_id,
    title: r.title,
    sourcePath: r.source_path,
    bodySha: r.body_sha,
    status: r.status,
    cycle: r.cycle,
    claimedRunId: r.claimed_run_id,
    claimedAt: r.claimed_at,
    lastRunId: r.last_run_id,
    lastVerifiedAt: r.last_verified_at,
    findingCount: r.finding_count,
  };
}

/* ---------- repo state (cycle counter) ---------- */

export function getRepoCycle(repoId: string): number {
  const row = getDb()
    .prepare<[string], { cycle: number }>('SELECT cycle FROM qa_ios_repo_state WHERE repo_id = ?')
    .get(repoId);
  return row?.cycle ?? 0;
}

export function ensureRepoState(repoId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO qa_ios_repo_state (repo_id, cycle) VALUES (?, 0)`)
    .run(repoId);
}

export function bumpRepoCycle(repoId: string): number {
  ensureRepoState(repoId);
  getDb().prepare('UPDATE qa_ios_repo_state SET cycle = cycle + 1 WHERE repo_id = ?').run(repoId);
  return getRepoCycle(repoId);
}

export function setSetupAt(repoId: string, at: string | null): void {
  ensureRepoState(repoId);
  getDb().prepare('UPDATE qa_ios_repo_state SET setup_at = ? WHERE repo_id = ?').run(at, repoId);
}

export function getSetupAt(repoId: string): string | null {
  const row = getDb()
    .prepare<
      [string],
      { setup_at: string | null }
    >('SELECT setup_at FROM qa_ios_repo_state WHERE repo_id = ?')
    .get(repoId);
  return row?.setup_at ?? null;
}

/* ---------- flow registry CRUD ---------- */

export interface SyncFlowInput {
  flowId: string;
  repoId: string;
  title: string;
  sourcePath: string;
  bodySha: string;
}

/**
 * Sync the parsed flow files into the registry. Algorithm:
 *  1. For each input, if a row with the same flow_id already exists:
 *     - body_sha unchanged → no-op.
 *     - body_sha changed → update body_sha + demote status to 'outdated'.
 *  2. If the flow_id is new but there's an existing UNCLAIMED row in the
 *     same repo with the same body_sha (rename detection), migrate:
 *     copy the run history into a fresh row under the new id, record the
 *     migration audit, delete the old row.
 *  3. Otherwise insert a fresh 'pending' row.
 *  4. Rows for flows that no longer appear in the inputs are LEFT IN PLACE
 *     (deletion is the user's call — they may have just temporarily
 *     removed a file).
 *
 * Returns the migrations performed so callers can surface a UI badge.
 */
export interface FlowMigration {
  oldId: string;
  newId: string;
  migratedAt: string;
}

export function syncFlows(repoId: string, inputs: SyncFlowInput[]): FlowMigration[] {
  ensureRepoState(repoId);
  const db = getDb();
  const now = new Date().toISOString();
  const migrations: FlowMigration[] = [];

  const tx = db.transaction((items: SyncFlowInput[]) => {
    for (const f of items) {
      const existing = db
        .prepare<[string], FlowDbRow>('SELECT * FROM qa_ios_flows WHERE flow_id = ?')
        .get(f.flowId);

      if (existing) {
        if (existing.body_sha !== f.bodySha) {
          db.prepare(
            `UPDATE qa_ios_flows
                SET body_sha = ?, title = ?, source_path = ?,
                    status = CASE
                      WHEN status = 'running' THEN 'running'
                      ELSE 'outdated'
                    END
              WHERE flow_id = ?`,
          ).run(f.bodySha, f.title, f.sourcePath, f.flowId);
        } else {
          // title or path may still have changed
          db.prepare(`UPDATE qa_ios_flows SET title = ?, source_path = ? WHERE flow_id = ?`).run(
            f.title,
            f.sourcePath,
            f.flowId,
          );
        }
        continue;
      }

      // New flow_id — try rename migration.
      const candidate = db
        .prepare<[string, string], FlowDbRow>(
          `SELECT * FROM qa_ios_flows
            WHERE repo_id = ? AND body_sha = ?
              AND claimed_run_id IS NULL
              AND status != 'running'
            LIMIT 1`,
        )
        .get(repoId, f.bodySha);

      if (candidate) {
        db.prepare(
          `INSERT INTO qa_ios_flows
             (flow_id, repo_id, title, source_path, body_sha, status, cycle,
              last_run_id, last_verified_at, finding_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          f.flowId,
          repoId,
          f.title,
          f.sourcePath,
          f.bodySha,
          candidate.status === 'outdated' ? 'outdated' : candidate.status,
          candidate.cycle,
          candidate.last_run_id,
          candidate.last_verified_at,
          candidate.finding_count,
        );
        db.prepare('DELETE FROM qa_ios_flows WHERE flow_id = ?').run(candidate.flow_id);
        db.prepare(
          `INSERT INTO qa_ios_flow_id_migrations (new_id, old_id, repo_id, migrated_at)
           VALUES (?, ?, ?, ?)`,
        ).run(f.flowId, candidate.flow_id, repoId, now);
        migrations.push({ oldId: candidate.flow_id, newId: f.flowId, migratedAt: now });
        continue;
      }

      // Fresh flow — insert pending.
      db.prepare(
        `INSERT INTO qa_ios_flows
           (flow_id, repo_id, title, source_path, body_sha, status, cycle)
         VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
      ).run(f.flowId, repoId, f.title, f.sourcePath, f.bodySha);
    }
  });

  tx(inputs);
  return migrations;
}

export function listFlows(repoId: string): QaFlowRow[] {
  return getDb()
    .prepare<[string], FlowDbRow>('SELECT * FROM qa_ios_flows WHERE repo_id = ? ORDER BY title')
    .all(repoId)
    .map(mapFlowRow);
}

export function getFlow(flowId: string): QaFlowRow | null {
  const row = getDb()
    .prepare<[string], FlowDbRow>('SELECT * FROM qa_ios_flows WHERE flow_id = ?')
    .get(flowId);
  return row ? mapFlowRow(row) : null;
}

export function listMigrationsForRepo(
  repoId: string,
): { newId: string; oldId: string; migratedAt: string }[] {
  return getDb()
    .prepare<[string], { new_id: string; old_id: string; migrated_at: string }>(
      `SELECT new_id, old_id, migrated_at FROM qa_ios_flow_id_migrations
        WHERE repo_id = ?
        ORDER BY migrated_at DESC`,
    )
    .all(repoId)
    .map((r) => ({ newId: r.new_id, oldId: r.old_id, migratedAt: r.migrated_at }));
}

/* ---------- atomic claim ---------- */

/**
 * Atomically claim the next claimable flow for this repo. Priority order:
 *   failed → outdated → inconclusive → pending
 * (re-test what we know is broken first, fall back to never-tested).
 *
 * Same-row CAS: select a candidate, then UPDATE with predicate
 * `claimed_run_id IS NULL`. If two callers race, the one that loses gets
 * `changes === 0` and we retry once. Returns null when nothing claimable.
 *
 * If `preferredFlowId` is provided, try to claim THAT flow first; if it's
 * not claimable, fall back to the priority order.
 */
export function claimNextFlow(
  repoId: string,
  runId: string,
  preferredFlowId?: string,
  opts?: { force?: boolean },
): QaFlowRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const cycle = getRepoCycle(repoId);

  // `force` (manual Retry / infra auto-retry) lets the preferred flow be
  // reclaimed even when it already 'passed' this cycle — the user explicitly
  // asked to re-run it. We never steal a flow another LIVE run holds, so
  // `claimed_run_id IS NULL` always applies.
  const tryClaim = (flowId: string, allowPassed = false): QaFlowRow | null => {
    const statuses = allowPassed
      ? "('pending','outdated','failed','inconclusive','passed')"
      : "('pending','outdated','failed','inconclusive')";
    const upd = db
      .prepare(
        `UPDATE qa_ios_flows
            SET claimed_run_id = ?, claimed_at = ?, status = 'running'
          WHERE flow_id = ?
            AND repo_id = ?
            AND claimed_run_id IS NULL
            AND status IN ${statuses}`,
      )
      .run(runId, now, flowId, repoId);
    if (upd.changes !== 1) return null;
    db.prepare('UPDATE qa_ios_flows SET cycle = ? WHERE flow_id = ?').run(cycle, flowId);
    return getFlow(flowId);
  };

  const tx = db.transaction((): QaFlowRow | null => {
    if (preferredFlowId) {
      const claimed = tryClaim(preferredFlowId, opts?.force === true);
      if (claimed) return claimed;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = db
        .prepare<[string], { flow_id: string }>(
          `SELECT flow_id FROM qa_ios_flows
            WHERE repo_id = ?
              AND claimed_run_id IS NULL
              AND status IN ('pending','outdated','failed','inconclusive')
            ORDER BY
              CASE status
                WHEN 'failed' THEN 0
                WHEN 'outdated' THEN 1
                WHEN 'inconclusive' THEN 2
                ELSE 3
              END,
              flow_id
            LIMIT 1`,
        )
        .get(repoId);
      if (!candidate) return null;
      const claimed = tryClaim(candidate.flow_id);
      if (claimed) return claimed;
      // someone else won; loop and try the next candidate
    }
    return null;
  });

  return tx();
}

/**
 * Release a claim and write the outcome. The cycle predicate ensures that
 * a stale callback from a pre-reset run is dropped — its writeback would
 * not match the current cycle, so the row stays whatever the reset left it.
 */
export function recordFlowOutcome(input: {
  flowId: string;
  runId: string;
  status: Exclude<QaFlowStatus, 'running' | 'pending' | 'outdated'>;
  findingCount: number;
}): boolean {
  const now = new Date().toISOString();
  const cycle = (() => {
    const row = getDb()
      .prepare<
        [string],
        { cycle: number; repo_id: string }
      >('SELECT cycle, repo_id FROM qa_ios_flows WHERE flow_id = ?')
      .get(input.flowId);
    if (!row) return null;
    return { cycle: row.cycle, repoId: row.repo_id };
  })();
  if (!cycle) return false;
  const currentRepoCycle = getRepoCycle(cycle.repoId);

  const upd = getDb()
    .prepare(
      `UPDATE qa_ios_flows
          SET status = ?, claimed_run_id = NULL, claimed_at = NULL,
              last_run_id = ?, last_verified_at = ?, finding_count = ?
        WHERE flow_id = ?
          AND claimed_run_id = ?
          AND cycle = ?`,
    )
    .run(
      input.status,
      input.runId,
      now,
      input.findingCount,
      input.flowId,
      input.runId,
      currentRepoCycle,
    );
  return upd.changes === 1;
}

export function releaseFlowClaim(flowId: string, runId: string): void {
  // Used on run failure to undo a claim without recording an outcome.
  getDb()
    .prepare(
      `UPDATE qa_ios_flows
          SET claimed_run_id = NULL, claimed_at = NULL, status = 'pending'
        WHERE flow_id = ? AND claimed_run_id = ?`,
    )
    .run(flowId, runId);
}

/* ---------- reset ---------- */

export function resetFlows(repoId: string, scope: 'unverified' | 'all'): { cycle: number } {
  const db = getDb();
  ensureRepoState(repoId);

  const tx = db.transaction(() => {
    db.prepare('UPDATE qa_ios_repo_state SET cycle = cycle + 1 WHERE repo_id = ?').run(repoId);
    if (scope === 'all') {
      db.prepare(
        `UPDATE qa_ios_flows
            SET status = 'pending', claimed_run_id = NULL, claimed_at = NULL,
                last_run_id = NULL, last_verified_at = NULL, finding_count = 0
          WHERE repo_id = ?`,
      ).run(repoId);
    } else {
      db.prepare(
        `UPDATE qa_ios_flows
            SET status = 'pending', last_run_id = NULL, last_verified_at = NULL,
                finding_count = 0
          WHERE repo_id = ? AND claimed_run_id IS NULL`,
      ).run(repoId);
    }
  });
  tx();
  return { cycle: getRepoCycle(repoId) };
}

/* ---------- stale claim sweep ---------- */

export function sweepStaleFlowClaims(maxAgeMs: number): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const upd = getDb()
    .prepare(
      `UPDATE qa_ios_flows
          SET claimed_run_id = NULL, claimed_at = NULL, status = 'pending'
        WHERE claimed_run_id IS NOT NULL AND claimed_at < ?`,
    )
    .run(cutoff);
  return upd.changes;
}

/* ---------- sim slots ---------- */

export interface SimSlotRow {
  slotIndex: number;
  udid: string;
  appiumPort: number;
  wdaPort: number;
  claimedRunId: string | null;
  claimedAt: string | null;
}

interface SimSlotDbRow {
  slot_index: number;
  udid: string;
  appium_port: number;
  wda_port: number;
  claimed_run_id: string | null;
  claimed_at: string | null;
}

function mapSlotRow(r: SimSlotDbRow): SimSlotRow {
  return {
    slotIndex: r.slot_index,
    udid: r.udid,
    appiumPort: r.appium_port,
    wdaPort: r.wda_port,
    claimedRunId: r.claimed_run_id,
    claimedAt: r.claimed_at,
  };
}

export function listSimSlots(): SimSlotRow[] {
  return getDb()
    .prepare<[], SimSlotDbRow>('SELECT * FROM qa_ios_sim_slots ORDER BY slot_index')
    .all()
    .map(mapSlotRow);
}

export function upsertSimSlot(input: {
  slotIndex: number;
  udid: string;
  appiumPort: number;
  wdaPort: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO qa_ios_sim_slots (slot_index, udid, appium_port, wda_port)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slot_index) DO UPDATE SET
         udid = excluded.udid,
         appium_port = excluded.appium_port,
         wda_port = excluded.wda_port`,
    )
    .run(input.slotIndex, input.udid, input.appiumPort, input.wdaPort);
}

export function allocateSimSlot(runId: string): SimSlotRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction((): SimSlotRow | null => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = db
        .prepare<[], SimSlotDbRow>(
          `SELECT * FROM qa_ios_sim_slots
            WHERE claimed_run_id IS NULL
            ORDER BY slot_index
            LIMIT 1`,
        )
        .get();
      if (!candidate) return null;
      const upd = db
        .prepare(
          `UPDATE qa_ios_sim_slots
              SET claimed_run_id = ?, claimed_at = ?
            WHERE slot_index = ? AND claimed_run_id IS NULL`,
        )
        .run(runId, now, candidate.slot_index);
      if (upd.changes === 1)
        return mapSlotRow({ ...candidate, claimed_run_id: runId, claimed_at: now });
    }
    return null;
  });
  return tx();
}

export function releaseSimSlot(runId: string): void {
  getDb()
    .prepare(
      `UPDATE qa_ios_sim_slots
          SET claimed_run_id = NULL, claimed_at = NULL
        WHERE claimed_run_id = ?`,
    )
    .run(runId);
}

export function sweepStaleSimSlots(maxAgeMs: number): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const upd = getDb()
    .prepare(
      `UPDATE qa_ios_sim_slots
          SET claimed_run_id = NULL, claimed_at = NULL
        WHERE claimed_run_id IS NOT NULL AND claimed_at < ?`,
    )
    .run(cutoff);
  return upd.changes;
}

/* ---------- comment-once-per-cycle (R5) ---------- */

/**
 * Look at the audit_log for prior `qa_commented` rows in this cycle.
 * If found, the agent should emit a noop instead of another comment so a
 * persistently-failing flow doesn't spam comments on every run.
 */
export function commentedThisCycle(input: {
  repoId: string;
  flowId: string;
  cycle: number;
}): boolean {
  // audit_log payload is JSON text; we can search via json_extract.
  const row = getDb()
    .prepare<[string, string, number], { c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE kind = 'qa_commented'
          AND json_extract(payload, '$.repo_id') = ?
          AND json_extract(payload, '$.flow_id') = ?
          AND json_extract(payload, '$.cycle') = ?`,
    )
    .get(input.repoId, input.flowId, input.cycle);
  return (row?.c ?? 0) > 0;
}
