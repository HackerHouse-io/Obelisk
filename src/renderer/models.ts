import type { RunnerKind } from '../shared/types';

/**
 * Model dropdowns are populated dynamically and CLI-sourced — never an API key.
 * The main process reads the CLI's configured default and probes the CLI's
 * init handshake for the concrete model each always-latest alias resolves to.
 * See `src/main/runners/model-discovery.ts`.
 *
 * The renderer fetches via `models:list` IPC. `MODEL_OPTIONS` below is the
 * boot-time fallback — used for the first paint before the IPC resolves and
 * when the IPC is unavailable. Claude rows are the always-latest family
 * aliases (`opus`/`sonnet`/`haiku`); the backend overlays the resolved version
 * onto the labels. Keep it short; the discovery layer is the source of truth.
 */
export interface ModelOption {
  id: string;
  label: string;
  tier: 'flagship' | 'balanced' | 'fast' | 'reasoning';
}

export const MODEL_OPTIONS: Record<RunnerKind, ModelOption[]> = {
  claude: [
    { id: 'opus', label: 'Opus', tier: 'flagship' },
    { id: 'sonnet', label: 'Sonnet', tier: 'balanced' },
    { id: 'haiku', label: 'Haiku', tier: 'fast' },
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

/** Where the version labels came from — drives the refresh-button tooltip. */
export type ModelSource = 'cli-probe' | 'observed' | 'fallback';

/**
 * Fetch models for a runner from the main process. Falls back to the alias
 * list above on IPC failure (handler not registered, etc.) so the dropdown is
 * never empty. Pass `refresh` to force a fresh CLI init-probe.
 */
export async function fetchModelsForRunner(
  runner: RunnerKind,
  refresh = false,
): Promise<{
  models: ModelOption[];
  defaultModelId: string | null;
  source: ModelSource;
  fetchedAt: string;
}> {
  try {
    const res = await window.obelisk.invoke('models:list', { runner, refresh });
    if (res.ok) {
      return {
        models: res.value.models,
        defaultModelId: res.value.defaultModelId,
        source: res.value.source,
        fetchedAt: res.value.fetchedAt,
      };
    }
  } catch {
    // fall through to the alias list
  }
  return {
    models: MODEL_OPTIONS[runner],
    defaultModelId: null,
    source: 'fallback',
    fetchedAt: new Date().toISOString(),
  };
}
