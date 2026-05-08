import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { MODEL_OPTIONS, fetchModelsForRunner, tierLabel, type ModelOption } from '../models';
import type { RunnerKind } from '../../shared/types';

const CUSTOM_SENTINEL = '__custom__';

interface Props {
  /** The active runner; '' means "Use Settings default" — picks at runtime. */
  runner: '' | RunnerKind;
  /** Current freeform value the user has chosen. Empty = Settings default. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Element id for the visible label to associate with. */
  id?: string;
}

interface FetchState {
  models: ModelOption[];
  defaultModelId: string | null;
  source: 'live-api' | 'curated' | 'fallback';
  fetchedAt: string | null;
  loading: boolean;
}

/**
 * Runner-aware model picker. Models are fetched dynamically from the main
 * process (which reads the user's CLI config + queries Anthropic / OpenAI
 * `/v1/models` when API keys are set), with a curated fallback used for the
 * first paint and when discovery fails.
 *
 * State semantics match `resolveRunnerModel` on the backend:
 *   - empty string  → falls through to Settings → CLI default
 *   - known id      → that model
 *   - anything else → that exact custom string passed verbatim
 *
 * When `runner === ''` (the user hasn't committed to a CLI), the curated
 * list is empty — only "Use default" + Custom… show up. We can't list
 * models we don't know the runner for.
 */
export function ModelSelect({ runner, value, onChange, disabled, id }: Props): ReactElement {
  // Boot-time fallback so the dropdown isn't empty before IPC returns.
  const initial = useMemo<FetchState>(
    () => ({
      models: runner === '' ? [] : MODEL_OPTIONS[runner],
      defaultModelId: null,
      source: 'fallback',
      fetchedAt: null,
      loading: runner !== '',
    }),
    [runner],
  );
  const [state, setState] = useState<FetchState>(initial);
  // Bump to force a re-fetch from a refresh button.
  const [refreshTick, setRefreshTick] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (runner === '') {
      setState({
        models: [],
        defaultModelId: null,
        source: 'fallback',
        fetchedAt: null,
        loading: false,
      });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    void fetchModelsForRunner(runner).then((res) => {
      if (!aliveRef.current) return;
      setState({
        models: res.models,
        defaultModelId: res.defaultModelId,
        source: res.source,
        fetchedAt: res.fetchedAt,
        loading: false,
      });
    });
  }, [runner, refreshTick]);

  const knownOptions = state.models;
  const isKnown = knownOptions.some((m) => m.id === value);
  const isCustom = value.trim().length > 0 && !isKnown;
  const [showingCustomInput, setShowingCustomInput] = useState(isCustom);

  // The select's effective value: '' for Settings default, the id for known
  // models, or CUSTOM_SENTINEL when the user picked Custom…
  const selectValue = value === '' ? '' : isKnown ? value : CUSTOM_SENTINEL;

  function onSelect(next: string): void {
    if (next === CUSTOM_SENTINEL) {
      setShowingCustomInput(true);
      // Don't clear the value — preserve any prior custom string.
      return;
    }
    setShowingCustomInput(false);
    onChange(next);
  }

  const defaultOptionLabel =
    runner !== '' && state.defaultModelId ? `Use default (${state.defaultModelId})` : 'Use default';

  return (
    <div className="model-select">
      <div className="model-select-row">
        <select
          id={id}
          className="file-issue-input"
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
          disabled={disabled}
          title={
            runner === ''
              ? 'Pick a runner above to see model options for that CLI'
              : `Choose a ${runner === 'claude' ? 'Claude Code' : 'Codex'} model, or "Custom…" to type any model id.`
          }
        >
          <option value="">{defaultOptionLabel}</option>
          {knownOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {tierLabel(m.tier)}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom model id…</option>
        </select>
        {runner !== '' ? (
          <button
            type="button"
            className="btn ghost sm model-select-refresh"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={disabled || state.loading}
            title={
              state.source === 'live-api'
                ? `Live from API · refresh`
                : state.source === 'curated'
                  ? `Curated fallback (no API key set) · refresh`
                  : 'Refresh model list'
            }
            aria-label="Refresh model list"
          >
            {state.loading ? '…' : '↻'}
          </button>
        ) : null}
      </div>
      {showingCustomInput || isCustom ? (
        <input
          type="text"
          className="file-issue-input model-select-custom"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. claude-3-5-sonnet-20241022"
          disabled={disabled}
          spellCheck={false}
          autoFocus={showingCustomInput && !isCustom}
        />
      ) : null}
    </div>
  );
}
