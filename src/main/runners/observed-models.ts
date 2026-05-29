import { getSetting, setSetting } from '../db/settings';

/**
 * Observed-model store.
 *
 * The `claude` CLI never exposes a machine-readable model list, but it *does*
 * announce the concrete model it resolved at the start of every run — the
 * `system:init` stream-json event carries `"model":"claude-opus-4-8"`. We
 * harvest that id (for free, from real runs) and from the cheap init-probe
 * (`model-probe.ts`), keyed by family alias, so the dropdown can label the
 * always-latest `opus`/`sonnet`/`haiku` rows with the real version the user's
 * CLI will actually pick.
 *
 * This is the no-API-key replacement for the old `/v1/models` lookup: the CLI
 * is the source of truth, not the Anthropic API.
 */

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku';

export interface ObservedModel {
  /** The concrete resolved id, e.g. `claude-opus-4-8`. */
  id: string;
  /** ISO timestamp this id was last seen. */
  at: string;
}

/** Map keyed by `claude:<family>` → last-observed concrete id. */
type ObservedStore = Record<string, ObservedModel>;

const SCOPE = 'app' as const;
const KEY = 'observedModels';

/**
 * Derive the family alias from a concrete model id. Handles version suffixes
 * and the `[1m]` context-window marker (`claude-opus-4-8[1m]`).
 */
export function familyOf(modelId: string): ClaudeFamily | null {
  if (/opus/i.test(modelId)) return 'opus';
  if (/sonnet/i.test(modelId)) return 'sonnet';
  if (/haiku/i.test(modelId)) return 'haiku';
  return null;
}

function read(): ObservedStore {
  try {
    return getSetting<ObservedStore>(SCOPE, KEY) ?? {};
  } catch {
    return {};
  }
}

/**
 * Record a concrete model id observed from a run or probe. No-ops when the id
 * doesn't map to a known family (e.g. a custom or third-party model). The
 * timestamp is supplied by the caller so this stays deterministic in tests.
 */
export function recordObserved(modelId: string, at: string): void {
  const family = familyOf(modelId);
  if (!family) return;
  const store = read();
  store[`claude:${family}`] = { id: modelId, at };
  try {
    setSetting(SCOPE, KEY, store);
  } catch {
    // Best-effort cache; a write failure must never break a run.
  }
}

/** The last-observed concrete id for a family, or null if never seen. */
export function readObserved(family: ClaudeFamily): ObservedModel | null {
  return read()[`claude:${family}`] ?? null;
}
