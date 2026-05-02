import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import type { Repo, RunnerKind, SafetyMode } from '../../shared/types';

type StepId = 'auth' | 'repo' | 'safety' | 'runner' | 'schedule' | 'start';

const STEPS: { id: StepId; title: string; sub: string }[] = [
  {
    id: 'auth',
    title: 'Sign in to GitHub',
    sub: 'OAuth Device Flow. Token stored in your OS keychain.',
  },
  {
    id: 'repo',
    title: 'Add a repository',
    sub: 'Pick an existing local clone or clone one from your account.',
  },
  {
    id: 'safety',
    title: 'Pick a safety level',
    sub: 'How much should agents be allowed to do? You can change this later.',
  },
  {
    id: 'runner',
    title: 'Pick a CLI runner',
    sub: 'Claude Code or Codex. You can override per agent later.',
  },
  {
    id: 'schedule',
    title: 'Pick a schedule',
    sub: 'Three presets. Per-agent schedules are configurable in Agents.',
  },
  {
    id: 'start',
    title: 'Review & start',
    sub: 'Confirm what we wired up. Agents will only run for allowlisted authors.',
  },
];

const SAFETY_OPTIONS: {
  mode: SafetyMode;
  title: string;
  sub: string;
  chips: string[];
  recommended?: boolean;
}[] = [
  {
    mode: 'observe',
    title: 'Observe only',
    sub: 'Read code, run tests, crawl the app. No GitHub writes. Recommended first run.',
    chips: ['read code', 'run tests', 'preview issues'],
    recommended: true,
  },
  {
    mode: 'issues',
    title: 'File issues',
    sub: '+ create issues with repro steps and commit the QA Playbook via PR for human approval.',
    chips: ['+ create issues', '+ commit qa/ via PR'],
  },
  {
    mode: 'prs',
    title: 'Open draft PRs',
    sub: '+ Bug Fixer and Feature Builder open draft PRs with full Evidence Pack. Human still merges.',
    chips: ['+ open draft PRs', '+ Evidence Pack required'],
  },
  {
    mode: 'automerge',
    title: 'Auto-merge safe fixes',
    sub: '+ Obelisk may merge a green draft PR that carries the obelisk:automerge label.',
    chips: ['+ auto-merge labeled PRs'],
  },
];

const RUNNER_OPTIONS: { runner: RunnerKind; title: string; sub: string; vendor: string }[] = [
  {
    runner: 'claude',
    title: 'Claude Code',
    vendor: 'Anthropic',
    sub: 'Best end-to-end task completion.',
  },
  {
    runner: 'codex',
    title: 'Codex',
    vendor: 'OpenAI',
    sub: 'Strong on PR review and Playwright loops.',
  },
];

const SCHEDULE_PRESETS: {
  id: string;
  title: string;
  sub: string;
  runsPerDay: string;
  cost: string;
}[] = [
  {
    id: 'observe',
    title: 'Observe',
    sub: 'Light pulse · ~5 runs/day',
    runsPerDay: '~5',
    cost: '$',
  },
  {
    id: 'balanced',
    title: 'Balanced',
    sub: 'Default cadence · ~80 runs/day',
    runsPerDay: '~80',
    cost: '$$',
  },
  {
    id: 'aggressive',
    title: 'Aggressive',
    sub: 'Continuous · ~250 runs/day',
    runsPerDay: '~250',
    cost: '$$$',
  },
];

interface DeviceFlow {
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
}

interface RepoChoice {
  source: 'local' | 'remote';
  localPath?: string;
  fullName?: string;
}

export function Connect(): ReactElement {
  const auth = useStore((s) => s.auth);
  const setAuth = useStore((s) => s.setAuth);
  const setRoute = useStore((s) => s.setRoute);
  const setRepos = useStore((s) => s.setRepos);
  const selectRepo = useStore((s) => s.selectRepo);

  const [stepIdx, setStepIdx] = useState(0);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [repoChoice, setRepoChoice] = useState<RepoChoice | null>(null);
  const [remoteRepos, setRemoteRepos] = useState<
    { fullName: string; defaultBranch: string; private: boolean; description: string | null }[]
  >([]);
  const [remoteRepoFilter, setRemoteRepoFilter] = useState('');
  const [remoteRepoLoading, setRemoteRepoLoading] = useState(false);

  const [safety, setSafety] = useState<SafetyMode>('observe');
  const [runner, setRunner] = useState<RunnerKind>('claude');
  const [schedulePreset, setSchedulePreset] = useState<string>('balanced');

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Skip step 1 if already signed in.
  useEffect(() => {
    if (auth.signedIn && stepIdx === 0) setStepIdx(1);
  }, [auth.signedIn, stepIdx]);

  // Countdown for the device-flow user code.
  useEffect(() => {
    if (!deviceFlow) return;
    setSecondsLeft(deviceFlow.expiresInSeconds);
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [deviceFlow]);

  const step = STEPS[stepIdx]!;
  const canAdvance = useMemo(() => {
    if (step.id === 'auth') return auth.signedIn;
    if (step.id === 'repo') return repoChoice !== null;
    return true;
  }, [step.id, auth.signedIn, repoChoice]);

  async function handleStartSignIn(): Promise<void> {
    setSigningIn(true);
    setAuthError(null);
    try {
      const res = await window.obelisk.invoke('auth:signIn', undefined);
      if (!res.ok) {
        setAuthError(res.error.message + (res.error.hint ? ` · ${res.error.hint}` : ''));
        setSigningIn(false);
        return;
      }
      setDeviceFlow(res.value);
      // Open the verification URI in the user's browser.
      window.open(res.value.verificationUri, '_blank', 'noopener');
      // Poll until completion.
      const completed = await window.obelisk.invoke('auth:complete', undefined);
      if (!completed.ok) {
        setAuthError(completed.error.message);
        setSigningIn(false);
        setDeviceFlow(null);
        return;
      }
      setAuth({ signedIn: true, login: completed.value.login, scope: completed.value.scope });
      setSigningIn(false);
      setDeviceFlow(null);
      setStepIdx(1);
    } catch (e) {
      setAuthError(String(e));
      setSigningIn(false);
    }
  }

  async function handlePickFolder(): Promise<void> {
    const res = await window.obelisk.invoke('repos:pickFolder', undefined);
    if (res.ok && res.value.path) {
      setRepoChoice({ source: 'local', localPath: res.value.path });
    }
  }

  async function loadRemoteRepos(): Promise<void> {
    setRemoteRepoLoading(true);
    const res = await window.obelisk.invoke('repos:listGitHubRepos', undefined);
    if (res.ok) setRemoteRepos(res.value);
    setRemoteRepoLoading(false);
  }

  async function handleFinish(): Promise<void> {
    if (!repoChoice) return;
    setCreating(true);
    setCreateError(null);
    try {
      const connectPayload =
        repoChoice.source === 'local'
          ? { localPath: repoChoice.localPath ?? '' }
          : { githubFullName: repoChoice.fullName ?? '' };
      const created = await window.obelisk.invoke('repos:connect', connectPayload);
      if (!created.ok) {
        setCreateError(
          created.error.message + (created.error.hint ? ` · ${created.error.hint}` : ''),
        );
        setCreating(false);
        return;
      }
      // The repo started in mode='observe'; honor the user's safety choice.
      let repo: Repo = created.value;
      if (safety !== 'observe') {
        const upgraded = await window.obelisk.invoke('repos:setMode', {
          repoId: repo.id,
          mode: safety,
        });
        if (upgraded.ok) repo = upgraded.value;
      }

      // Refresh the renderer store and route to Home.
      const list = await window.obelisk.invoke('repos:list', undefined);
      if (list.ok) setRepos(list.value);
      selectRepo(repo.id);
      setCreating(false);
      setRoute('home');
    } catch (e) {
      setCreateError(String(e));
      setCreating(false);
    }
  }

  return (
    <div className="wizard">
      <div className="wizard-stepper">
        {STEPS.map((s, i) => (
          <div
            key={s.id}
            className={`wizard-step-pill${i < stepIdx ? ' done' : i === stepIdx ? ' active' : ''}`}
          />
        ))}
      </div>
      <div className="wizard-body">
        <div className="wizard-body-inner">
          <div className="wizard-header">
            <div className="label">
              Step {stepIdx + 1} of {STEPS.length}
            </div>
            <div className="wizard-title">{step.title}</div>
            <div className="wizard-sub">{step.sub}</div>
          </div>

          {step.id === 'auth' && (
            <AuthStep
              signedIn={auth.signedIn}
              login={auth.login}
              deviceFlow={deviceFlow}
              secondsLeft={secondsLeft}
              signingIn={signingIn}
              error={authError}
              onStart={handleStartSignIn}
            />
          )}

          {step.id === 'repo' && (
            <RepoStep
              choice={repoChoice}
              setChoice={setRepoChoice}
              onPickFolder={handlePickFolder}
              remoteRepos={remoteRepos}
              remoteRepoFilter={remoteRepoFilter}
              setRemoteRepoFilter={setRemoteRepoFilter}
              loadRemoteRepos={loadRemoteRepos}
              loading={remoteRepoLoading}
            />
          )}

          {step.id === 'safety' && (
            <SafetyStep value={safety} onChange={setSafety} login={auth.login} />
          )}
          {step.id === 'runner' && <RunnerStep runner={runner} onChange={setRunner} />}
          {step.id === 'schedule' && (
            <ScheduleStep value={schedulePreset} onChange={setSchedulePreset} />
          )}
          {step.id === 'start' && (
            <StartStep
              login={auth.login ?? ''}
              repoChoice={repoChoice}
              safety={safety}
              runner={runner}
              schedulePreset={schedulePreset}
              creating={creating}
              error={createError}
              onFinish={handleFinish}
              onEdit={(s) => setStepIdx(s)}
            />
          )}

          <div className="wizard-footer">
            <button
              type="button"
              className="btn ghost"
              disabled={stepIdx === 0}
              onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            >
              <Icon.Chevron size={11} style={{ transform: 'rotate(180deg)' }} />
              Back
            </button>
            {step.id !== 'start' ? (
              <button
                type="button"
                className="btn primary"
                disabled={!canAdvance}
                onClick={() => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1))}
              >
                Continue
                <Icon.Chevron size={11} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="card" style={{ padding: 16 }}>
      {children}
    </div>
  );
}

function AuthStep({
  signedIn,
  login,
  deviceFlow,
  secondsLeft,
  signingIn,
  error,
  onStart,
}: {
  signedIn: boolean;
  login?: string;
  deviceFlow: DeviceFlow | null;
  secondsLeft: number;
  signingIn: boolean;
  error: string | null;
  onStart: () => void;
}): ReactElement {
  if (signedIn) {
    return (
      <Section>
        <div className="row gap-3">
          <Icon.Check size={16} color="var(--ok)" />
          <div className="col gap-1">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Signed in as @{login}</div>
            <div style={{ fontSize: 11.5, color: 'var(--t-2)' }}>
              Token stored in your OS keychain. Continue to add a repo.
            </div>
          </div>
        </div>
      </Section>
    );
  }

  if (deviceFlow) {
    const mins = Math.floor(secondsLeft / 60);
    const secs = String(secondsLeft % 60).padStart(2, '0');
    return (
      <Section>
        <div className="col gap-4">
          <div style={{ fontSize: 13 }}>
            Enter this code at <span className="mono">{deviceFlow.verificationUri}</span>
            {' (we opened it in your browser)'}.
          </div>
          <div className="code-display">{deviceFlow.userCode}</div>
          <div className="row gap-2" style={{ fontSize: 11.5, color: 'var(--t-2)' }}>
            <Icon.Spinner size={12} color="var(--brand)" />
            Waiting for browser authorization… {mins}:{secs}
          </div>
          <div className="row gap-2">
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                navigator.clipboard.writeText(deviceFlow.userCode).catch(() => undefined)
              }
            >
              Copy code
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => window.open(deviceFlow.verificationUri, '_blank', 'noopener')}
            >
              Open browser
            </button>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <div className="col gap-3">
        <div style={{ fontSize: 13, color: 'var(--t-1)' }}>
          We use GitHub OAuth Device Flow. Your token is stored in the OS keychain — never on disk.
        </div>
        {error ? <div className="tone-error">{error}</div> : null}
        <div>
          <button type="button" className="btn primary lg" onClick={onStart} disabled={signingIn}>
            <Icon.GitHub size={13} />
            {signingIn ? 'Starting…' : 'Sign in with GitHub'}
          </button>
        </div>
      </div>
    </Section>
  );
}

function RepoStep({
  choice,
  setChoice,
  onPickFolder,
  remoteRepos,
  remoteRepoFilter,
  setRemoteRepoFilter,
  loadRemoteRepos,
  loading,
}: {
  choice: RepoChoice | null;
  setChoice: (c: RepoChoice | null) => void;
  onPickFolder: () => Promise<void>;
  remoteRepos: {
    fullName: string;
    defaultBranch: string;
    private: boolean;
    description: string | null;
  }[];
  remoteRepoFilter: string;
  setRemoteRepoFilter: (s: string) => void;
  loadRemoteRepos: () => Promise<void>;
  loading: boolean;
}): ReactElement {
  const [mode, setMode] = useState<'local' | 'remote'>('local');

  useEffect(() => {
    if (mode === 'remote' && remoteRepos.length === 0 && !loading) {
      void loadRemoteRepos();
    }
  }, [mode, remoteRepos.length, loading, loadRemoteRepos]);

  const filtered = remoteRepos.filter((r) =>
    r.fullName.toLowerCase().includes(remoteRepoFilter.toLowerCase()),
  );

  return (
    <div className="col gap-3">
      <div className="row gap-2">
        <button
          type="button"
          className={`btn${mode === 'local' ? ' primary' : ''}`}
          onClick={() => setMode('local')}
        >
          <Icon.Folder size={12} /> Use a local clone
        </button>
        <button
          type="button"
          className={`btn${mode === 'remote' ? ' primary' : ''}`}
          onClick={() => setMode('remote')}
        >
          <Icon.GitHub size={12} /> Clone from GitHub
        </button>
      </div>

      {mode === 'local' ? (
        <Section>
          <div className="col gap-3">
            <div style={{ fontSize: 13, color: 'var(--t-1)' }}>
              Pick the root of an existing git checkout. Origin must point to github.com.
            </div>
            <div>
              <button type="button" className="btn" onClick={onPickFolder}>
                <Icon.Folder size={12} />
                Choose folder…
              </button>
            </div>
            {choice?.source === 'local' && choice.localPath ? (
              <div className="tone-info">
                Selected: <span className="mono">{choice.localPath}</span>
              </div>
            ) : null}
          </div>
        </Section>
      ) : (
        <Section>
          <div className="col gap-3">
            <input
              className="input"
              placeholder="Filter your repos…"
              value={remoteRepoFilter}
              onChange={(e) => setRemoteRepoFilter(e.target.value)}
            />
            {loading ? (
              <div className="row gap-2" style={{ color: 'var(--t-2)', fontSize: 12 }}>
                <Icon.Spinner size={12} /> Fetching repos…
              </div>
            ) : (
              <div className="repo-list">
                {filtered.length === 0 ? (
                  <div style={{ padding: 12, color: 'var(--t-2)', fontSize: 12 }}>
                    No repos match.
                  </div>
                ) : (
                  filtered.slice(0, 50).map((r) => {
                    const selected = choice?.source === 'remote' && choice.fullName === r.fullName;
                    return (
                      <div
                        key={r.fullName}
                        className={`repo-list-item${selected ? ' selected' : ''}`}
                        onClick={() => setChoice({ source: 'remote', fullName: r.fullName })}
                      >
                        <Icon.GitHub size={12} color="var(--t-1)" />
                        <div className="flex-1">
                          <div className="mono" style={{ fontSize: 12.5 }}>
                            {r.fullName}
                          </div>
                          {r.description ? (
                            <div className="truncate" style={{ fontSize: 11, color: 'var(--t-2)' }}>
                              {r.description}
                            </div>
                          ) : null}
                        </div>
                        {r.private ? (
                          <span className="pill" style={{ height: 18 }}>
                            <Icon.Lock size={9} /> private
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--t-2)' }}>
              We&apos;ll clone into your app data directory using your OAuth token. The clone uses
              HTTPS.
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

function SafetyStep({
  value,
  onChange,
  login,
}: {
  value: SafetyMode;
  onChange: (m: SafetyMode) => void;
  login?: string;
}): ReactElement {
  return (
    <div className="col gap-3">
      {SAFETY_OPTIONS.map((opt) => (
        <button
          key={opt.mode}
          type="button"
          className={`choice-card${value === opt.mode ? ' selected' : ''}`}
          onClick={() => onChange(opt.mode)}
        >
          <div className="choice-row">
            <span className="radio-bullet" />
            <div className="flex-1">
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {opt.title}
                {opt.recommended ? (
                  <span className="pill brand" style={{ marginLeft: 8, height: 18 }}>
                    recommended
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--t-2)', marginTop: 4 }}>{opt.sub}</div>
              <div className="row gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {opt.chips.map((c) => (
                  <span key={c} className="pill">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </button>
      ))}

      <Section>
        <div className="col gap-2">
          <div className="row gap-2">
            <Icon.Shield size={14} color="var(--brand)" />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Allowed actors</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-2)' }}>
            Agents will only act on issues, PRs, and comments authored by allowlisted GitHub
            accounts. We&apos;ll add{' '}
            <span className="mono" style={{ color: 'var(--t-0)' }}>
              @{login ?? 'you'}
            </span>{' '}
            automatically. You can add collaborators in Settings → Allowed actors.
          </div>
        </div>
      </Section>
    </div>
  );
}

function RunnerStep({
  runner,
  onChange,
}: {
  runner: RunnerKind;
  onChange: (r: RunnerKind) => void;
}): ReactElement {
  return (
    <div className="col gap-3">
      <div className="col gap-3">
        {RUNNER_OPTIONS.map((opt) => (
          <button
            key={opt.runner}
            type="button"
            className={`choice-card${runner === opt.runner ? ' selected' : ''}`}
            onClick={() => onChange(opt.runner)}
          >
            <div className="choice-row">
              <span className="radio-bullet" />
              <div className="flex-1">
                <div style={{ fontSize: 14, fontWeight: 600 }}>{opt.title}</div>
                <div style={{ fontSize: 12, color: 'var(--t-2)', marginTop: 2 }}>{opt.vendor}</div>
                <div style={{ fontSize: 12.5, color: 'var(--t-2)', marginTop: 6 }}>{opt.sub}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="tone-info">
        Set API keys per runner in Settings. Auto-fallback kicks in after two consecutive failures
        on the same task.
      </div>
    </div>
  );
}

function ScheduleStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}): ReactElement {
  return (
    <div className="col gap-3">
      {SCHEDULE_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`choice-card${value === p.id ? ' selected' : ''}`}
          onClick={() => onChange(p.id)}
        >
          <div className="choice-row">
            <span className="radio-bullet" />
            <div className="flex-1">
              <div className="row gap-2" style={{ alignItems: 'baseline' }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{p.title}</div>
                <span className="pill">{p.cost}</span>
                <span className="pill">{p.runsPerDay}/day</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--t-2)', marginTop: 4 }}>{p.sub}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function StartStep({
  login,
  repoChoice,
  safety,
  runner,
  schedulePreset,
  creating,
  error,
  onFinish,
  onEdit,
}: {
  login: string;
  repoChoice: RepoChoice | null;
  safety: SafetyMode;
  runner: RunnerKind;
  schedulePreset: string;
  creating: boolean;
  error: string | null;
  onFinish: () => void;
  onEdit: (step: number) => void;
}): ReactElement {
  return (
    <div className="col gap-3">
      <SummaryRow label="GitHub" value={`@${login}`} onEdit={() => onEdit(0)} />
      <SummaryRow
        label="Repository"
        value={
          repoChoice?.source === 'local'
            ? (repoChoice.localPath ?? '')
            : (repoChoice?.fullName ?? '— none —')
        }
        onEdit={() => onEdit(1)}
      />
      <SummaryRow
        label="Safety level"
        value={SAFETY_OPTIONS.find((s) => s.mode === safety)?.title ?? safety}
        onEdit={() => onEdit(2)}
      />
      <SummaryRow
        label="CLI runner"
        value={RUNNER_OPTIONS.find((r) => r.runner === runner)?.title ?? runner}
        onEdit={() => onEdit(3)}
      />
      <SummaryRow
        label="Schedule"
        value={SCHEDULE_PRESETS.find((p) => p.id === schedulePreset)?.title ?? schedulePreset}
        onEdit={() => onEdit(4)}
      />

      {error ? <div className="tone-error">{error}</div> : null}

      <div className="row gap-2" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn primary lg"
          onClick={onFinish}
          disabled={creating || !repoChoice}
        >
          {creating ? (
            <>
              <Icon.Spinner size={13} /> Connecting…
            </>
          ) : (
            <>
              Start
              <Icon.ArrowRight size={12} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="summary-row">
      <div className="col gap-1">
        <div className="label">{label}</div>
        <div className="summary-value mono truncate" style={{ maxWidth: 380 }}>
          {value}
        </div>
      </div>
      <button type="button" className="btn ghost sm" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}
