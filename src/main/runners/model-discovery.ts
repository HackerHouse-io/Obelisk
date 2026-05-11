import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunnerKind } from '../../shared/types';

/**
 * Dynamic model discovery.
 *
 * The renderer used to ship a hardcoded curated list, which rotted as soon as
 * model names shipped (the user reported the dropdown showing `gpt-5.1-codex`
 * after their local Codex CLI was already on `gpt-5.5`).
 *
 * This module returns a freshly-discovered list at request time, in this
 * order of preference:
 *   1. Live API list (Anthropic for Claude, OpenAI for Codex), when the user
 *      has set ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment.
 *   2. The model the user already has wired into their CLI's config —
 *      surfaced as the "current default" so they see what their CLI will
 *      actually pick when they choose "Use default".
 *   3. A curated fallback list. Updated whenever models ship; kept short.
 *
 * Results are merged + deduped so a model that shows up in both the API and
 * the curated list appears once. Custom freetext entry is still supported by
 * the renderer's `ModelSelect` component.
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
  /** Where the list came from — drives a "live"/"cached" pill in the UI. */
  source: 'live-api' | 'curated';
  /** ISO timestamp the result was assembled. */
  fetchedAt: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

// Curated fallback. Single source of truth — the renderer mirrors this for
// first-paint, but the IPC always overlays freshly-discovered entries on top.
export const CURATED_MODELS: Record<RunnerKind, DiscoveredModel[]> = {
  claude: [
    // Use full pinned ids — `claude --model` accepts the alias (`sonnet`,
    // `opus`, `haiku`) or the full name (`claude-sonnet-4-6`), but rejects
    // version-suffixed shorthand like `sonnet-4-6` with exit 1.
    { id: 'claude-opus-4-7', label: 'Opus 4.7', tier: 'flagship' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'fast' },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'flagship' },
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', tier: 'reasoning' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
  ],
};

export async function discoverModels(runner: RunnerKind): Promise<ModelDiscoveryResult> {
  const fetchedAt = new Date().toISOString();
  const defaultModelId = await readCliDefaultModel(runner).catch(() => null);

  const live = await fetchLiveModels(runner).catch(() => null);
  const curated = CURATED_MODELS[runner];

  // Dedup by id, prefer live entries' labels/tiers (they may carry richer
  // display names) while keeping curated entries that the API didn't return.
  const seen = new Set<string>();
  const merged: DiscoveredModel[] = [];
  for (const m of [...(live ?? []), ...curated]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }

  // If the CLI's configured default isn't in the merged list yet, prepend it
  // so the user sees their actual current model even when it's brand-new and
  // missing from both live and curated sources.
  if (defaultModelId && !seen.has(defaultModelId)) {
    merged.unshift({
      id: defaultModelId,
      label: defaultModelId,
      tier: 'flagship',
    });
  }

  return {
    runner,
    models: merged,
    defaultModelId,
    source: live ? 'live-api' : 'curated',
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

/* ---------- Live API fetchers ---------- */

async function fetchLiveModels(runner: RunnerKind): Promise<DiscoveredModel[] | null> {
  if (runner === 'claude') {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) return null;
    return fetchAnthropicModels(key).catch(() => null);
  }
  const key = process.env['OPENAI_API_KEY'];
  if (!key) return null;
  return fetchOpenAIModels(key).catch(() => null);
}

interface AnthropicModelsResponse {
  data?: { id?: string; display_name?: string }[];
}

async function fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch(ANTHROPIC_MODELS_URL, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
  });
  if (!res.ok) throw new Error(`anthropic /v1/models returned ${res.status}`);
  const json = (await res.json()) as AnthropicModelsResponse;
  const data = Array.isArray(json.data) ? json.data : [];
  return data
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id,
      tier: classifyClaudeTier(m.id),
    }));
}

interface OpenAIModelsResponse {
  data?: { id?: string }[];
}

async function fetchOpenAIModels(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openai /v1/models returned ${res.status}`);
  const json = (await res.json()) as OpenAIModelsResponse;
  const data = Array.isArray(json.data) ? json.data : [];
  // /v1/models returns the entire account-visible catalog (gpt-3.5, embeddings,
  // tts, etc.). For Codex the only useful subset is the gpt-* / o-* reasoning
  // family, since codex CLI rejects everything else.
  return data
    .filter((m): m is { id: string } => typeof m.id === 'string')
    .filter((m) => isCodexCompatibleModelId(m.id))
    .map((m) => ({
      id: m.id,
      label: prettifyOpenAILabel(m.id),
      tier: classifyCodexTier(m.id),
    }));
}

function isCodexCompatibleModelId(id: string): boolean {
  // Codex CLI accepts gpt-* and o-series reasoning models. Filter out audio,
  // tts, embedding, image, etc.
  if (/embedding|whisper|tts|audio|image|dall-e|moderation/i.test(id)) return false;
  return /^(gpt-|o\d|o-mini|codex)/i.test(id);
}

function prettifyOpenAILabel(id: string): string {
  // "gpt-5.5" → "GPT-5.5"; "gpt-5-mini" → "GPT-5 Mini"; leave the rest alone.
  return id
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-mini\b/i, ' Mini')
    .replace(/-codex\b/i, ' Codex');
}

function classifyClaudeTier(id: string): DiscoveredModel['tier'] {
  if (/opus/i.test(id)) return 'flagship';
  if (/haiku/i.test(id)) return 'fast';
  if (/sonnet/i.test(id)) return 'balanced';
  return 'balanced';
}

function classifyCodexTier(id: string): DiscoveredModel['tier'] {
  if (/mini\b/i.test(id)) return 'fast';
  if (/codex/i.test(id)) return 'reasoning';
  return 'flagship';
}
