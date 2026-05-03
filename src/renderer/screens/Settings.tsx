import { useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import type {
  AttributionMode,
  RunnerKind,
  SafetyMode,
  Settings as AppSettings,
} from '../../shared/types';

const SAFETY_OPTIONS: { mode: SafetyMode; title: string; sub: string }[] = [
  { mode: 'observe', title: 'Observe only', sub: 'Read code, run tests, crawl. No GitHub writes.' },
  { mode: 'issues', title: 'File issues', sub: '+ create issues, commit qa/ via PR.' },
  { mode: 'prs', title: 'Open draft PRs', sub: '+ Bug Fixer / Feature Builder open draft PRs.' },
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

  if (!repo || !settings) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">Settings</div>
        <div className="placeholder-body">{!repo ? 'Connect a repo first.' : 'Loading…'}</div>
      </div>
    );
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
        alert(res.error.message);
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

  async function changeAttribution(mode: AttributionMode): Promise<void> {
    const res = await window.obelisk.invoke('settings:update', { attributionMode: mode });
    if (res.ok) setLocalSettings(res.value);
  }

  async function setKey(runner: RunnerKind, key: string): Promise<void> {
    if (!key.trim()) return;
    const res = await window.obelisk.invoke('auth:setRunnerKey', { runner, key: key.trim() });
    if (!res.ok) alert(res.error.message);
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
      alert(res.error.message);
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
        onChange={changeDefaultRunner}
        onSetKey={setKey}
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
  onChange,
  onSetKey,
}: {
  defaultRunner: RunnerKind;
  onChange: (r: RunnerKind) => void;
  onSetKey: (r: RunnerKind, k: string) => Promise<void>;
}): ReactElement {
  const [claudeKey, setClaudeKey] = useState('');
  const [codexKey, setCodexKey] = useState('');

  return (
    <div className="settings-card">
      <div className="settings-card-title">CLI runner</div>
      <div className="settings-card-sub">
        Pick the default runner for new agents. Per-agent overrides are configured in Agents.
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

      <div className="settings-row">
        <div>
          <div className="settings-row-label">ANTHROPIC_API_KEY</div>
          <div className="settings-row-help">
            Stored in your OS keychain. Never written to disk in cleartext.
          </div>
        </div>
        <div className="row gap-2">
          <input
            className="input settings-input"
            type="password"
            placeholder="sk-ant-..."
            value={claudeKey}
            onChange={(e) => setClaudeKey(e.target.value)}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              void onSetKey('claude', claudeKey).then(() => setClaudeKey(''));
            }}
            disabled={!claudeKey.trim()}
          >
            Save
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div>
          <div className="settings-row-label">OPENAI_API_KEY</div>
          <div className="settings-row-help">
            Stored in your OS keychain. Never written to disk in cleartext.
          </div>
        </div>
        <div className="row gap-2">
          <input
            className="input settings-input"
            type="password"
            placeholder="sk-..."
            value={codexKey}
            onChange={(e) => setCodexKey(e.target.value)}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              void onSetKey('codex', codexKey).then(() => setCodexKey(''));
            }}
            disabled={!codexKey.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
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
