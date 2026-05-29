import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import {
  familyOf,
  recordObserved,
  readObserved,
} from '../../src/main/runners/observed-models';
import { formatModelLabel, discoverModels } from '../../src/main/runners/model-discovery';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-model-discovery-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('familyOf', () => {
  it('derives the family from concrete ids, ignoring date and [1m] suffixes', () => {
    expect(familyOf('claude-opus-4-8')).toBe('opus');
    expect(familyOf('claude-opus-4-8[1m]')).toBe('opus');
    expect(familyOf('claude-sonnet-4-6')).toBe('sonnet');
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(familyOf('gpt-5.5')).toBeNull();
  });
});

describe('formatModelLabel', () => {
  it('formats a concrete id into a family + version label', () => {
    expect(formatModelLabel('claude-opus-4-8', 'opus')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-opus-4-8[1m]', 'opus')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-haiku-4-5-20251001', 'haiku')).toBe('Haiku 4.5');
  });

  it('falls back to the capitalized family when no version is known', () => {
    expect(formatModelLabel(null, 'sonnet')).toBe('Sonnet');
    expect(formatModelLabel('opus', 'opus')).toBe('Opus');
  });
});

describe('observed-models store', () => {
  it('records and reads back the last-observed concrete id per family', () => {
    recordObserved('claude-opus-4-8[1m]', '2026-05-28T00:00:00.000Z');
    expect(readObserved('opus')).toEqual({
      id: 'claude-opus-4-8[1m]',
      at: '2026-05-28T00:00:00.000Z',
    });
    expect(readObserved('sonnet')).toBeNull();
  });

  it('ignores ids that map to no known family', () => {
    recordObserved('gpt-5.5', '2026-05-28T00:00:00.000Z');
    expect(readObserved('opus')).toBeNull();
  });
});

describe('discoverModels (claude, warm cache)', () => {
  it('labels the always-latest alias rows with the observed version, no probe', async () => {
    const now = (): string => '2026-05-28T00:00:00.000Z';
    recordObserved('claude-opus-4-8', now());
    recordObserved('claude-sonnet-4-6', now());
    recordObserved('claude-haiku-4-5', now());

    const res = await discoverModels('claude', { refresh: false, now });

    // Rows are the bare aliases (so the CLI always resolves latest)...
    expect(res.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    // ...labelled with the concrete version the CLI resolved.
    expect(res.models.map((m) => m.label)).toEqual(['Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5']);
    expect(res.source).toBe('observed');
    expect(res.runner).toBe('claude');
  });
});

describe('discoverModels (codex)', () => {
  it('returns curated concrete rows (no alias mechanism)', async () => {
    const res = await discoverModels('codex', { now: () => '2026-05-28T00:00:00.000Z' });
    expect(res.runner).toBe('codex');
    expect(res.models.some((m) => m.id === 'gpt-5.5')).toBe(true);
  });
});
