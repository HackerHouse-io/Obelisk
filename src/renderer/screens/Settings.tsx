import { useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { useStore } from '../state/store';
import { MODEL_OPTIONS, fetchModelsForRunner, tierLabel, type ModelOption } from '../models';
import { showApiAlert } from '../state/alert-store';
import type {
  AttributionMode,
  RunnerKind,
  SafetyMode,
  Settings as AppSettings,
} from '../../shared/types';

const SAFETY_OPTIONS: { mode: SafetyMode; title: string; sub: string }[] = [
  { mode: 'observe', title: 'Observe only', sub: 'Read code, run tests, crawl. No GitHub writes.' },
  { mode: 'issues', title: 'File issues', sub: '+ create issues, commit qa/ via PR.' },
  {
    mode: 'prs',
    title: 'Open PRs',
    sub: '+ Bug Fixer / Feature Builder open PRs ready for review.',
  },
  {
    mode: 'automerge',
    title: 'Auto-merge safe fixes',
    sub: '+ merge labeled green PRs without human approval.',
  },
];

const ATTRIBUTION_OPTIONS: { value: AttributionMode; title: string; sub: string }[] = [
  {
    value: 'user',
    title: 'User-attributed',
    sub: 'Inherit your local git config. Commits land under the connected GitHub account.',
  },
  {
    value: 'bot',
    title: 'Bot-attributed',
    sub: 'Override the author with an "Obelisk Bot" identity.',
  },
  {
    value: 'custom',
    title: 'Custom identity',
    sub: 'Set an alternate name and email per repo.',
  },
];

interface AllowlistEntry {
  login: string;
  addedAt: string;
  addedBy: string;
}

export function SettingsScreen(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const auth = useStore((s) => s.auth);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [settings, setLocalSettings] = useState<AppSettings | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [allowlistInput, setAllowlistInput] = useState('');
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.obelisk.invoke('settings:get', undefined).then((res) => {
      if (res.ok) setLocalSettings(res.value);
    });
  }, []);

  useEffect(() => {
    if (!repo) return;
    void window.obelisk.invoke('allowlist:list', { repoId: repo.id }).then((res) => {
      if (res.ok) setAllowlist(res.value);
    });
  }, [repo]);

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Settings are per-repo. Connect one first."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }
  if (!settings) {
    return <EmptyState title="Loading settings…" />;
  }

  async function changeMode(target: SafetyMode): Promise<void> {
    setBusy(true);
    const res = await window.obelisk.invoke('repos:setMode', {
      repoId: repo!.id,
      mode: target,
    });
    setBusy(false);
    if (!res.ok) {
      // If the API surface needs a broader OAuth scope, kick off the upgrade.
      if (res.error.code === 'AUTH_REQUIRED') {
        await window.obelisk.invoke('auth:upgradeScope', { to: target });
      } else {
        showApiAlert(res.error, 'change safety mode');
      }
      return;
    }
    // Refresh repos.
    const list = await window.obelisk.invoke('repos:list', undefined);
    if (list.ok) useStore.getState().setRepos(list.value);
  }

  async function changeDefaultRunner(runner: RunnerKind): Promise<void> {
    const res = await window.obelisk.invoke('settings:update', { defaultRunner: runner });
    if (res.ok) setLocalSettings(res.value);
  }

  async function changeClaudeModel(model: string): Promise<void> {
    const res = await window.obelisk.invoke('settings:update', { claudeModel: model });
    if (res.ok) setLocalSettings(res.value);
  }

  async function changeCodexModel(model: string): Promise<void> {
    const res = await window.obelisk.invoke('settings:update', { codexModel: model });
    if (res.ok) setLocalSettings(res.value);
  }

  async function changeAttribution(mode: AttributionMode): Promise<void> {
    const res = await window.obelisk.invoke('settings:update', { attributionMode: mode });
    if (res.ok) setLocalSettings(res.value);
  }

  async function addAllowlist(login: string): Promise<void> {
    setAllowlistError(null);
    const trimmed = login.trim().replace(/^@/, '');
    if (!trimmed) return;
    const res = await window.obelisk.invoke('allowlist:add', {
      repoId: repo!.id,
      login: trimmed,
    });
    if (!res.ok) {
      setAllowlistError(res.error.message);
      return;
    }
    setAllowlistInput('');
    const list = await window.obelisk.invoke('allowlist:list', { repoId: repo!.id });
    if (list.ok) setAllowlist(list.value);
  }

  async function removeAllowlist(login: string): Promise<void> {
    const res = await window.obelisk.invoke('allowlist:remove', {
      repoId: repo!.id,
      login,
    });
    if (!res.ok) {
      showApiAlert(res.error, 'remove from allowlist');
      return;
    }
    const list = await window.obelisk.invoke('allowlist:list', { repoId: repo!.id });
    if (list.ok) setAllowlist(list.value);
  }

  return (
    <div className="settings">
      <div>
        <div className="settings-title">Settings</div>
        <div className="settings-sub">
          {repo.githubFullName} · signed in as @{auth.login ?? '?'}
        </div>
      </div>

      <SafetyCard mode={repo.mode} busy={busy} onChange={changeMode} />

      <RunnerCard
        defaultRunner={settings.defaultRunner}
        claudeModel={settings.claudeModel}
        codexModel={settings.codexModel}
        onChange={changeDefaultRunner}
        onChangeClaudeModel={changeClaudeModel}
        onChangeCodexModel={changeCodexModel}
      />

      <AttributionCard mode={settings.attributionMode} onChange={changeAttribution} />

      <AllowlistCard
        entries={allowlist}
        connectedLogin={auth.login}
        input={allowlistInput}
        setInput={setAllowlistInput}
        error={allowlistError}
        onAdd={addAllowlist}
        onRemove={removeAllowlist}
      />

      <div className="settings-card disabled-card">
        <div className="row gap-2">
          <Icon.External size={14} color="var(--t-2)" />
          <div className="settings-card-title">Cloud execution</div>
          <span className="pill" style={{ marginLeft: 'auto' }}>
            v0.2
          </span>
        </div>
        <div className="settings-card-sub">
          Run schedules in GitHub Actions when Obelisk is closed. Lands in v0.2 with the optional
          cloud-execution worker.
        </div>
      </div>
    </div>
  );
}

function SafetyCard({
  mode,
  busy,
  onChange,
}: {
  mode: SafetyMode;
  busy: boolean;
  onChange: (m: SafetyMode) => void;
}): ReactElement {
  return (
    <div className="settings-card">
      <div className="settings-card-title">Safety mode</div>
      <div className="settings-card-sub">
        Controls how much agents are allowed to do. Bumping the mode triggers a re-authorize prompt
        if GitHub needs broader scope.
      </div>
      <div className="col gap-2">
        {SAFETY_OPTIONS.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            className={`choice-card${mode === opt.mode ? ' selected' : ''}`}
            onClick={() => onChange(opt.mode)}
            disabled={busy}
          >
            <div className="choice-row">
              <span className="radio-bullet" />
              <div className="flex-1">
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{opt.title}</div>
                <div style={{ fontSize: 12, color: 'var(--t-2)', marginTop: 4 }}>{opt.sub}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function RunnerCard({
  defaultRunner,
  claudeModel,
  codexModel,
  onChange,
  onChangeClaudeModel,
  onChangeCodexModel,
}: {
  defaultRunner: RunnerKind;
  claudeModel: string;
  codexModel: string;
  onChange: (r: RunnerKind) => void;
  onChangeClaudeModel: (m: string) => void;
  onChangeCodexModel: (m: string) => void;
}): ReactElement {
  return (
    <div className="settings-card">
      <div className="settings-card-title">CLI runner</div>
      <div className="settings-card-sub">
        Pick the default runner for new agents. Per-agent overrides are configured in Agents.
        Authenticate the CLI itself by running <span className="mono">claude login</span> or{' '}
        <span className="mono">codex login</span> in a terminal — Obelisk inherits whatever
        credentials the CLI already has.
      </div>
      <div className="row gap-2">
        {(['claude', 'codex'] as RunnerKind[]).map((r) => (
          <button
            key={r}
            type="button"
            className={`btn${defaultRunner === r ? ' primary' : ''}`}
            onClick={() => onChange(r)}
          >
            {r === 'claude' ? <Icon.Sparkles size={12} /> : <Icon.Code size={12} />}
            {r === 'claude' ? 'Claude Code' : 'Codex'}
          </button>
        ))}
      </div>

      <div className="settings-runner-models">
        <div className="settings-card-sub" style={{ marginTop: 12 }}>
          Default model per runner. Leave on <span className="mono">Use CLI default</span> to let
          the CLI fall back to its account default — the safe choice if you sign in with a ChatGPT
          account or aren&rsquo;t sure which models you have access to. The list is read from your
          CLI config and the live <span className="mono">/v1/models</span> endpoint, so it stays in
          sync as model names rotate.
        </div>
        <ModelSelect
          label="Claude model"
          runner="claude"
          value={claudeModel}
          onCommit={onChangeClaudeModel}
        />
        <ModelSelect
          label="Codex model"
          runner="codex"
          value={codexModel}
          onCommit={onChangeCodexModel}
        />
      </div>
    </div>
  );
}

function ModelSelect({
  label,
  runner,
  value,
  onCommit,
}: {
  label: string;
  runner: RunnerKind;
  value: string;
  onCommit: (next: string) => void;
}): ReactElement {
  // Mirrors the Agents → Runner & model dropdown: `MODEL_OPTIONS` is the
  // first-paint fallback, replaced once `models:list` resolves with the live
  // CLI-config + Anthropic/OpenAI /v1/models list.
  const [models, setModels] = useState<ModelOption[]>(MODEL_OPTIONS[runner]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchModelsForRunner(runner).then((res) => {
      if (!alive) return;
      setModels(res.models);
      setDefaultModelId(res.defaultModelId);
    });
    return () => {
      alive = false;
    };
  }, [runner, refreshTick]);

  // If the user previously typed a model id that's no longer in the list,
  // surface it as a sticky option so we don't silently drop their setting.
  const stickyValue = value && !models.some((m) => m.id === value) ? value : null;

  return (
    <label className="settings-model-input">
      <span className="settings-model-label">{label}</span>
      <div className="row gap-2" style={{ alignItems: 'stretch', flex: 1 }}>
        <select
          className="input"
          value={value}
          onChange={(e) => onCommit(e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="">Use CLI default{defaultModelId ? ` (${defaultModelId})` : ''}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {tierLabel(m.tier)}
            </option>
          ))}
          {stickyValue ? <option value={stickyValue}>{stickyValue} · custom</option> : null}
        </select>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setRefreshTick((t) => t + 1)}
          title="Refresh model list (re-reads CLI config + live API)"
          aria-label="Refresh model list"
        >
          ↻
        </button>
      </div>
    </label>
  );
}

function AttributionCard({
  mode,
  onChange,
}: {
  mode: AttributionMode;
  onChange: (m: AttributionMode) => void;
}): ReactElement {
  return (
    <div className="settings-card">
      <div className="settings-card-title">Commit attribution</div>
      <div className="settings-card-sub">
        Every Obelisk commit ends with <span className="mono">[obelisk:&lt;agent&gt;]</span> and a{' '}
        <span className="mono">Co-Authored-By: Obelisk</span> trailer regardless of mode.
      </div>
      <div className="col gap-2">
        {ATTRIBUTION_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`choice-card${mode === opt.value ? ' selected' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <div className="choice-row">
              <span className="radio-bullet" />
              <div className="flex-1">
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{opt.title}</div>
                <div style={{ fontSize: 12, color: 'var(--t-2)', marginTop: 4 }}>{opt.sub}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AllowlistCard({
  entries,
  connectedLogin,
  input,
  setInput,
  error,
  onAdd,
  onRemove,
}: {
  entries: AllowlistEntry[];
  connectedLogin: string | undefined;
  input: string;
  setInput: (s: string) => void;
  error: string | null;
  onAdd: (login: string) => Promise<void>;
  onRemove: (login: string) => Promise<void>;
}): ReactElement {
  return (
    <div className="settings-card">
      <div className="row gap-2">
        <Icon.Shield size={14} color="var(--brand)" />
        <div className="settings-card-title">Allowed actors</div>
      </div>
      <div className="settings-card-sub">
        Agents will only act on issues, PRs, and comments authored by these GitHub accounts. The
        connected user is auto-added on first connect.
      </div>
      <div className="col gap-2">
        {entries.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No allowlist entries — agents will skip every issue/PR until at least one login is
            added.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.login} className="allowlist-row">
              <Icon.GitHub size={12} color="var(--t-1)" />
              <span className="mono flex-1">@{e.login}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                added {e.addedBy === 'auto' ? 'automatically' : `by @${e.addedBy}`}
              </span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  void onRemove(e.login);
                }}
                disabled={connectedLogin?.toLowerCase() === e.login.toLowerCase()}
                title={
                  connectedLogin?.toLowerCase() === e.login.toLowerCase()
                    ? 'Cannot remove the connected account'
                    : 'Remove'
                }
              >
                <Icon.Close size={11} />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="row gap-2">
        <input
          className="input"
          placeholder="github-username"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onAdd(input);
          }}
        />
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            void onAdd(input);
          }}
          disabled={!input.trim()}
        >
          <Icon.Plus size={12} /> Add
        </button>
      </div>
      {error ? <div className="tone-error">{error}</div> : null}
    </div>
  );
}
