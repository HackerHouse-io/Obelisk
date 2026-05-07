import type { RunnerKind } from '../shared/types';

/**
 * Model dropdowns are populated dynamically — the main process discovers
 * models from the user's CLI config (`~/.codex/config.toml`,
 * `~/.claude/settings.json`) and, when API keys are present, from the live
 * Anthropic / OpenAI `/v1/models` endpoints. See
 * `src/main/runners/model-discovery.ts`.
 *
 * The renderer fetches via `models:list` IPC. `MODEL_OPTIONS` below is the
 * boot-time fallback — used for the first paint before the IPC resolves and
 * when the renderer is offline. Keep it short and current; the live
 * discovery layer is the source of truth.
 */
export interface ModelOption {
  id: string;
  label: string;
  tier: 'flagship' | 'balanced' | 'fast' | 'reasoning';
}

export const MODEL_OPTIONS: Record<RunnerKind, ModelOption[]> = {
  claude: [
    { id: 'opus-4-7', label: 'Opus 4.7', tier: 'flagship' },
    { id: 'sonnet-4-6', label: 'Sonnet 4.6', tier: 'balanced' },
    { id: 'haiku-4-5', label: 'Haiku 4.5', tier: 'fast' },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'flagship' },
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', tier: 'reasoning' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
  ],
};

/** Pretty-print a tier — used in dropdown labels. */
export function tierLabel(tier: ModelOption['tier']): string {
  switch (tier) {
    case 'flagship':
      return 'flagship';
    case 'balanced':
      return 'balanced';
    case 'fast':
      return 'fast';
    case 'reasoning':
      return 'reasoning';
  }
}

/** Find the curated entry for a given (runner, id) pair, if any. */
export function findModelOption(runner: RunnerKind, id: string): ModelOption | null {
  return MODEL_OPTIONS[runner].find((m) => m.id === id) ?? null;
}

/**
 * Fetch models for a runner from the main process. Falls back to the curated
 * list above on IPC failure (offline, handler not registered, etc.) so the
 * dropdown is never empty.
 */
export async function fetchModelsForRunner(runner: RunnerKind): Promise<{
  models: ModelOption[];
  defaultModelId: string | null;
  source: 'live-api' | 'curated';
  fetchedAt: string;
}> {
  try {
    const res = await window.obelisk.invoke('models:list', { runner });
    if (res.ok) {
      return {
        models: res.value.models,
        defaultModelId: res.value.defaultModelId,
        source: res.value.source,
        fetchedAt: res.value.fetchedAt,
      };
    }
  } catch {
    // fall through to curated
  }
  return {
    models: MODEL_OPTIONS[runner],
    defaultModelId: null,
    source: 'curated',
    fetchedAt: new Date().toISOString(),
  };
}
