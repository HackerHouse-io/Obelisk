import { describe, it, expect } from 'vitest';
import {
  PRESETS,
  matchPreset,
  presetToConfig,
  type PresetId,
} from '../../src/renderer/screens/agents/schedule-helpers';
import type { ScheduleConfig } from '../../src/shared/types';

const BASE: ScheduleConfig = {
  mode: 'recurring',
  every: 1,
  unit: 'hour',
  at: '02:00',
  days: [1, 1, 1, 1, 1, 1, 1],
  tz: 'America/Los_Angeles',
};

describe('schedule presets', () => {
  it('every preset id round-trips through presetToConfig + matchPreset', () => {
    for (const def of PRESETS) {
      const cfg = presetToConfig(def.id, BASE);
      expect(matchPreset(cfg)).toBe(def.id);
    }
  });

  it('manual config matches "off"', () => {
    expect(matchPreset({ mode: 'manual' })).toBe('off');
  });

  it('cron-mode configs do not match any preset (force Custom)', () => {
    expect(matchPreset({ mode: 'cron', cron: '0 * * * *' })).toBeNull();
    expect(matchPreset({ mode: 'cron', cron: '*/15 * * * *' })).toBeNull();
  });

  it('event-mode configs do not match any preset', () => {
    expect(matchPreset({ mode: 'event', events: ['push'] })).toBeNull();
  });

  it('recurring with non-all days does not match (Custom)', () => {
    const cfg: ScheduleConfig = {
      mode: 'recurring',
      every: 1,
      unit: 'hour',
      days: [1, 1, 1, 1, 1, 0, 0],
    };
    expect(matchPreset(cfg)).toBeNull();
  });

  it('recurring with off-table cadence does not match', () => {
    expect(
      matchPreset({
        mode: 'recurring',
        every: 7,
        unit: 'minute',
        days: [1, 1, 1, 1, 1, 1, 1],
      }),
    ).toBeNull();
    expect(
      matchPreset({
        mode: 'recurring',
        every: 3,
        unit: 'hour',
        days: [1, 1, 1, 1, 1, 1, 1],
      }),
    ).toBeNull();
  });

  it('Daily preset matches only when at = 09:00', () => {
    const builtAt09 = presetToConfig('daily', BASE);
    expect(matchPreset(builtAt09)).toBe('daily');
    const cfg = { ...builtAt09, at: '08:00' };
    expect(matchPreset(cfg)).toBeNull();
  });

  it('preserves guardrail fields from the previous config', () => {
    const prev: ScheduleConfig = {
      ...BASE,
      maxConcurrent: 2,
      maxPerDay: 12,
      pauseLowCredit: true,
    };
    const next = presetToConfig('hourly', prev);
    expect(next.maxConcurrent).toBe(2);
    expect(next.maxPerDay).toBe(12);
    expect(next.pauseLowCredit).toBe(true);
  });

  it('every preset id appears in the chip table', () => {
    const ids: PresetId[] = ['off', '5min', '10min', '30min', 'hourly', '6hr', 'daily'];
    const presetIds = PRESETS.map((p) => p.id);
    for (const id of ids) expect(presetIds).toContain(id);
  });
});
