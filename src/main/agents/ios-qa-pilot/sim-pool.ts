import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  allocateSimSlot as dbAllocate,
  releaseSimSlot as dbRelease,
  listSimSlots,
  upsertSimSlot,
  sweepStaleSimSlots,
  type SimSlotRow,
} from '../../db/qa-flows';

const exec = promisify(execFile);

export type { SimSlotRow };

export interface BootstrapOpts {
  size: number;
  appiumPortBase: number;
  wdaPortBase: number;
  /** Device family + runtime for newly-cloned simulators. */
  device: string;
  os?: string;
}

/**
 * Idempotent: ensure `size` slots exist in the DB, each backed by a real
 * cloned simulator UDID. Already-populated slots are left alone.
 *
 * Cloning happens via `xcrun simctl clone` from a base device (created on
 * first call). We deliberately do NOT shut sims down here — the caller
 * (Doctor "Run setup") will call `keepBooted()` afterwards.
 */
export async function bootstrapPool(opts: BootstrapOpts): Promise<SimSlotRow[]> {
  const existing = listSimSlots();
  const byIndex = new Map(existing.map((s) => [s.slotIndex, s]));
  const slots: SimSlotRow[] = [];

  for (let i = 0; i < opts.size; i++) {
    const cached = byIndex.get(i);
    if (cached) {
      slots.push(cached);
      continue;
    }
    const udid = await createSimulator(`obelisk-runs-${i}`, opts.device, opts.os);
    upsertSimSlot({
      slotIndex: i,
      udid,
      appiumPort: opts.appiumPortBase + i,
      wdaPort: opts.wdaPortBase + i,
    });
    slots.push({
      slotIndex: i,
      udid,
      appiumPort: opts.appiumPortBase + i,
      wdaPort: opts.wdaPortBase + i,
      claimedRunId: null,
      claimedAt: null,
    });
  }
  return slots;
}

export async function keepBooted(): Promise<void> {
  for (const slot of listSimSlots()) {
    await safeBoot(slot.udid);
  }
}

export async function shutdownAll(): Promise<void> {
  for (const slot of listSimSlots()) {
    await safeShutdown(slot.udid);
  }
}

export async function eraseSlot(udid: string): Promise<void> {
  // Erase data without shutting down — preserves the boot warmth.
  await runOrIgnore('xcrun', ['simctl', 'erase', udid]);
}

export function allocateSimSlot(runId: string): SimSlotRow | null {
  return dbAllocate(runId);
}

export function releaseSimSlot(runId: string): void {
  dbRelease(runId);
}

export function sweepStale(maxAgeMs: number): number {
  return sweepStaleSimSlots(maxAgeMs);
}

/* ---------- xcrun helpers ---------- */

async function createSimulator(
  name: string,
  device: string,
  os: string | undefined,
): Promise<string> {
  // Resolve device type identifier
  const deviceType = await resolveDeviceType(device);
  const runtime = await resolveRuntime(os);
  const { stdout } = await exec('xcrun', ['simctl', 'create', name, deviceType, runtime]);
  const udid = stdout.trim();
  if (!udid) throw new Error(`simctl create returned empty UDID for ${name}`);
  return udid;
}

async function resolveDeviceType(device: string): Promise<string> {
  // The user passes a friendly name like "iPhone 15"; xcrun wants
  // "com.apple.CoreSimulator.SimDeviceType.iPhone-15".
  const id = `com.apple.CoreSimulator.SimDeviceType.${device.replace(/\s+/g, '-')}`;
  return id;
}

async function resolveRuntime(os: string | undefined): Promise<string> {
  if (os && os.length > 0) {
    return `com.apple.CoreSimulator.SimRuntime.iOS-${os.replace(/\./g, '-')}`;
  }
  // Otherwise pick the newest installed iOS runtime.
  const { stdout } = await exec('xcrun', ['simctl', 'list', 'runtimes', '-j']);
  try {
    const parsed = JSON.parse(stdout) as {
      runtimes: { identifier: string; isAvailable: boolean }[];
    };
    const iosRuntimes = parsed.runtimes.filter(
      (r) => r.isAvailable && r.identifier.includes('SimRuntime.iOS-'),
    );
    if (iosRuntimes.length === 0) {
      throw new Error('No iOS simulator runtimes installed');
    }
    iosRuntimes.sort((a, b) => a.identifier.localeCompare(b.identifier));
    return iosRuntimes[iosRuntimes.length - 1]!.identifier;
  } catch (e) {
    if (e instanceof Error && e.message.includes('No iOS')) throw e;
    throw new Error('Failed to parse `xcrun simctl list runtimes` output');
  }
}

async function safeBoot(udid: string): Promise<void> {
  await runOrIgnore('xcrun', ['simctl', 'boot', udid]);
}

async function safeShutdown(udid: string): Promise<void> {
  await runOrIgnore('xcrun', ['simctl', 'shutdown', udid]);
}

async function runOrIgnore(cmd: string, args: string[]): Promise<void> {
  try {
    await exec(cmd, args);
  } catch {
    // Boot/shutdown often returns a benign error if the device is already in
    // the requested state; we don't want that to throw.
  }
}
