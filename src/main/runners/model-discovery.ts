import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunnerKind } from '../../shared/types';
import { familyOf, readObserved, recordObserved, type ClaudeFamily } from './observed-models';
import { probeResolvedModel } from './model-probe';

/**
 * Dynamic model discovery — CLI-sourced, never an API key.
 *
 * The renderer used to ship a hardcoded curated list, which rotted the moment
 * a new model shipped (the dropdown showed `Opus 4.7` after the CLI had already
 * moved to `Opus 4.8`). An earlier fix queried Anthropic/OpenAI `/v1/models`,
 * but that only works with an API key — this app authenticates via the CLI's
 * own subscription/OAuth session, so the API path always fell back to stale
 * curated data.
 *
 * Instead we treat the CLI as the source of truth, with two no-API-key signals:
 *
 *   1. **Family aliases are always-latest.** The Claude rows are the bare
 *      aliases `opus` / `sonnet` / `haiku`; `claude --model opus` resolves to
 *      the newest model in that family, so a run is always-latest with no code
 *      change when the CLI updates.
 *   2. **The init handshake reveals the concrete version, for free.** Every run
 *      — and a cheap one-line probe (`model-probe.ts`) — announces the resolved
 *      id (`claude-opus-4-8`) in its `system:init` event. We cache it
 *      (`observed-models.ts`) and use it to label the alias rows ("Opus 4.8").
 *
 * Custom freetext entry is still supported by the renderer's `ModelSelect`, so
 * a user can pin an exact version for reproducibility.
 */

export interface DiscoveredModel {
  id: string;
  label: string;
  tier: 'flagship' | 'balanced' | 'fast' | 'reasoning';
}

export interface ModelDiscoveryResult {
  runner: RunnerKind;
  models: DiscoveredModel[];
  /** The model the CLI will use when no override is passed (read from CLI config). */
  defaultModelId: string | null;
  /**
   * Provenance of the version labels:
   *   - `cli-probe`: refreshed this call via the init handshake.
   *   - `observed`:  served from a previously-harvested resolved id.
   *   - `fallback`:  no concrete version known yet — alias rows only.
   */
  source: 'cli-probe' | 'observed' | 'fallback';
  /** ISO timestamp the result was assembled. */
  fetchedAt: string;
}

interface DiscoverOpts {
  /** Force a fresh init-probe of every Claude family (the refresh button). */
  refresh?: boolean;
  /** Injected clock for deterministic tests. */
  now?: () => string;
}

/** Re-probe a family when its cached id is older than this. */
const OBSERVED_TTL_MS = 6 * 60 * 60 * 1000;

const CLAUDE_FAMILIES: { family: ClaudeFamily; tier: DiscoveredModel['tier'] }[] = [
  { family: 'opus', tier: 'flagship' },
  { family: 'sonnet', tier: 'balanced' },
  { family: 'haiku', tier: 'fast' },
];

// Codex has no always-latest alias, so its rows stay concrete. Kept short and
// updated when models ship; the CLI's configured default (read below) is
// always surfaced on top so a brand-new model the user already wired in shows.
const CURATED_CODEX: DiscoveredModel[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'flagship' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', tier: 'reasoning' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
];

export async function discoverModels(
  runner: RunnerKind,
  opts: DiscoverOpts = {},
): Promise<ModelDiscoveryResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const fetchedAt = now();
  const defaultModelId = await readCliDefaultModel(runner).catch(() => null);

  if (runner === 'codex') {
    return discoverCodex(defaultModelId, fetchedAt);
  }
  return discoverClaude(defaultModelId, fetchedAt, Boolean(opts.refresh), now);
}

/* ---------- Claude (alias rows + CLI-observed versions) ---------- */

async function discoverClaude(
  defaultModelId: string | null,
  fetchedAt: string,
  refresh: boolean,
  now: () => string,
): Promise<ModelDiscoveryResult> {
  const nowMs = Date.parse(fetchedAt);

  // Decide which families need a fresh probe. On a cold store (nothing ever
  // observed) we await so the first open already shows real versions; on a
  // warm store we serve cached ids instantly and refresh stale ones in the
  // background. The refresh button always awaits all three.
  const observed = new Map<ClaudeFamily, ReturnType<typeof readObserved>>();
  for (const { family } of CLAUDE_FAMILIES) observed.set(family, readObserved(family));
  const cold = [...observed.values()].every((o) => o === null);

  const isStale = (family: ClaudeFamily): boolean => {
    const o = observed.get(family) ?? null;
    if (!o) return true;
    const ageMs = nowMs - Date.parse(o.at);
    return Number.isFinite(ageMs) ? ageMs > OBSERVED_TTL_MS : true;
  };

  let probed = false;
  if (refresh || cold) {
    // Await: caller wants accurate labels now.
    const targets = CLAUDE_FAMILIES.filter(({ family }) => refresh || isStale(family));
    const results = await Promise.all(targets.map(({ family }) => probeFamily(family, now)));
    probed = results.some((id) => id !== null);
    for (const { family } of targets) observed.set(family, readObserved(family));
  } else {
    // Warm: don't block. Kick background probes for anything stale.
    for (const { family } of CLAUDE_FAMILIES) {
      if (isStale(family)) void probeFamily(family, now);
    }
  }

  const models: DiscoveredModel[] = CLAUDE_FAMILIES.map(({ family, tier }) => {
    const concrete = observed.get(family)?.id ?? null;
    return { id: family, label: formatModelLabel(concrete, family), tier };
  });

  const hasConcrete = [...observed.values()].some((o) => o !== null);
  const source: ModelDiscoveryResult['source'] = probed
    ? 'cli-probe'
    : hasConcrete
      ? 'observed'
      : 'fallback';

  return { runner: 'claude', models, defaultModelId, source, fetchedAt };
}

/**
 * Probe a family, deduping concurrent probes (multiple dropdowns can mount at
 * once) and recording the result so the next discovery serves it from cache.
 */
const inFlight = new Map<ClaudeFamily, Promise<string | null>>();

function probeFamily(family: ClaudeFamily, now: () => string): Promise<string | null> {
  const existing = inFlight.get(family);
  if (existing) return existing;
  const p = probeResolvedModel(family)
    .then((id) => {
      if (id) recordObserved(id, now());
      return id;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(family));
  inFlight.set(family, p);
  return p;
}

/**
 * Turn a concrete resolved id into a display label. Strips the `[1m]`
 * context-window marker and any trailing date suffix:
 *   `claude-opus-4-8`            → "Opus 4.8"
 *   `claude-haiku-4-5-20251001`  → "Haiku 4.5"
 * Falls back to the capitalized family name when no version is known yet.
 */
export function formatModelLabel(concreteId: string | null, family: ClaudeFamily): string {
  const Fam = family.charAt(0).toUpperCase() + family.slice(1);
  if (!concreteId) return Fam;
  const clean = concreteId.replace(/\[.*$/, '');
  const m = /(?:opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(clean);
  return m ? `${Fam} ${m[1]}.${m[2]}` : Fam;
}

/* ---------- Codex (curated rows + CLI-configured default) ---------- */

function discoverCodex(defaultModelId: string | null, fetchedAt: string): ModelDiscoveryResult {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  // Surface the CLI's configured default first if it isn't already curated, so
  // a model the user just wired into config.toml shows even when it's new.
  if (defaultModelId && !CURATED_CODEX.some((m) => m.id === defaultModelId)) {
    models.push({ id: defaultModelId, label: defaultModelId, tier: 'flagship' });
    seen.add(defaultModelId);
  }
  for (const m of CURATED_CODEX) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }
  return {
    runner: 'codex',
    models,
    defaultModelId,
    source: defaultModelId ? 'observed' : 'fallback',
    fetchedAt,
  };
}

/* ---------- CLI config readers ---------- */

/**
 * Returns the user's actively-configured CLI model, or null if not set.
 * - Codex: `~/.codex/config.toml` line `model = "..."`.
 * - Claude: `~/.claude/settings.json` field `model` or `defaultModel`.
 *
 * These files are user-owned config (not credentials) — the model name is
 * the only thing this function extracts.
 */
async function readCliDefaultModel(runner: RunnerKind): Promise<string | null> {
  if (runner === 'codex') return readCodexConfigModel();
  return readClaudeSettingsModel();
}

export async function readCodexConfigModel(): Promise<string | null> {
  try {
    const path = join(homedir(), '.codex', 'config.toml');
    const text = await readFile(path, 'utf8');
    // Match the top-level `model = "..."` line. We do NOT parse TOML in full
    // because pulling a TOML dep for a single-line read is overkill and the
    // codex config file pins this assignment at the top of the file.
    const m = text.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
    return m ? (m[1] ?? '').trim() || null : null;
  } catch {
    return null;
  }
}

export async function readClaudeSettingsModel(): Promise<string | null> {
  try {
    const path = join(homedir(), '.claude', 'settings.json');
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const candidate =
      typeof parsed['model'] === 'string'
        ? parsed['model']
        : typeof parsed['defaultModel'] === 'string'
          ? parsed['defaultModel']
          : null;
    return candidate && candidate.trim().length > 0 ? candidate.trim() : null;
  } catch {
    return null;
  }
}

// Re-exported for callers that want the family classifier without importing
// the store module directly.
export { familyOf };
