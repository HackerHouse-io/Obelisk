import { useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import type { RunnerKind } from '../../shared/types';

/**
 * Sign-in instructions for each CLI runner. Both Claude Code and Codex
 * authenticate against their own backends and have to be signed in inside
 * a real terminal — we can't do it for them from inside the Electron app
 * (Claude's `/login` is an interactive REPL slash command).
 *
 * This card surfaces three escape hatches:
 *   1. Copy the exact sign-in command to the clipboard.
 *   2. Open the runner's sign-in / docs URL in the user's browser.
 *   3. "Verify sign-in" — runs a non-interactive probe (`codex login
 *      status` for Codex, `claude --print` for Claude) and reports back.
 *      This is the path for users who already signed in in a terminal but
 *      see a stale banner from a previous failed run.
 */
const INSTRUCTIONS: Record<
  RunnerKind,
  {
    name: string;
    command: string;
    followUp: string;
    docsUrl: string;
    /** Optional escape hatch: the env var that bypasses OAuth entirely. */
    apiKeyEnv: string;
  }
> = {
  claude: {
    name: 'Claude Code',
    command: 'claude',
    followUp:
      'When the REPL opens, type /login and follow the prompts. Close the REPL when you see "Logged in".',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/quickstart',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  codex: {
    name: 'Codex',
    command: 'codex login',
    followUp: 'Sign in with your OpenAI account in the browser window codex opens, then close it.',
    docsUrl: 'https://platform.openai.com/docs/codex',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
};

interface Props {
  runner: RunnerKind;
  onRetry?: () => void;
  /**
   * Fires once the "Verify sign-in" probe confirms a signed-in state. The
   * banner uses this to dismiss itself automatically — no point making the
   * user click an X after they just verified the runner is healthy.
   */
  onSignedIn?: () => void;
  /** Compact = inline action card inside the failed-run drawer. Banner = top-of-app surface. */
  variant?: 'compact' | 'banner';
}

type ProbeStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'signed_in'; detail: string }
  | { kind: 'signed_out'; detail: string }
  | { kind: 'cli_missing'; detail: string }
  | { kind: 'unknown'; detail: string };

export function RunnerLoginActionCard({
  runner,
  onRetry,
  onSignedIn,
  variant = 'compact',
}: Props): ReactElement {
  const info = INSTRUCTIONS[runner];
  const [copied, setCopied] = useState(false);
  const [probe, setProbe] = useState<ProbeStatus>({ kind: 'idle' });

  function copy(): void {
    void navigator.clipboard.writeText(info.command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  }

  function openDocs(): void {
    // setWindowOpenHandler in main/index.ts intercepts window.open and routes
    // the URL through shell.openExternal so it lands in the user's browser
    // rather than a new BrowserWindow.
    window.open(info.docsUrl, '_blank', 'noopener,noreferrer');
  }

  async function verify(): Promise<void> {
    setProbe({ kind: 'running' });
    const res = await window.obelisk.invoke('runner:probeAuth', { runner });
    if (!res.ok) {
      setProbe({ kind: 'unknown', detail: res.error.message });
      return;
    }
    setProbe({ kind: res.value.status, detail: res.value.detail });
    // Auto-dismiss the banner after a successful probe. Brief pause first so
    // the user actually reads the "Signed in" confirmation before the card
    // unmounts — instant disappearance reads as a click swallowed.
    if (res.value.status === 'signed_in' && onSignedIn) {
      window.setTimeout(() => onSignedIn(), 1400);
    }
  }

  return (
    <div className={`runner-login-card runner-login-card-${variant}`} role="alert">
      <div className="runner-login-card-icon">
        <Icon.AlertTri size={14} />
      </div>
      <div className="runner-login-card-body">
        <div className="runner-login-card-title">{info.name} is signed out</div>
        <div className="runner-login-card-text">
          {variant === 'banner'
            ? 'Scheduled runs that use this runner will fail until you sign in. '
            : null}
          Open a terminal on this machine and run:
        </div>
        <div className="runner-login-card-cmd">
          <code className="mono">{info.command}</code>
          <button
            type="button"
            className="btn ghost sm"
            onClick={copy}
            title="Copy command to clipboard"
          >
            {copied ? (
              <>
                <Icon.Check size={11} /> Copied
              </>
            ) : (
              <>
                <Icon.Doc size={11} /> Copy
              </>
            )}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={openDocs}
            title={`Open ${info.name} sign-in docs`}
          >
            <Icon.External size={11} /> Docs
          </button>
        </div>
        <div className="runner-login-card-followup">{info.followUp}</div>
        <div className="runner-login-card-hint">
          Already signed in? You can also set <code className="mono">{info.apiKeyEnv}</code> in the
          environment Obelisk launches from to skip OAuth entirely.
        </div>
        <div className="runner-login-card-actions">
          <button
            type="button"
            className="btn primary sm"
            onClick={() => void verify()}
            disabled={probe.kind === 'running'}
            title={`Run a non-interactive ${info.name} sign-in probe`}
          >
            {probe.kind === 'running' ? (
              <>
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
                Checking…
              </>
            ) : (
              <>
                <Icon.Check size={11} /> Verify sign-in
              </>
            )}
          </button>
          {onRetry ? (
            <button type="button" className="btn ghost sm" onClick={onRetry}>
              <Icon.Play size={11} /> I&rsquo;ve signed in — retry
            </button>
          ) : null}
        </div>
        {probe.kind !== 'idle' && probe.kind !== 'running' ? <ProbeResult status={probe} /> : null}
      </div>
    </div>
  );
}

function ProbeResult({
  status,
}: {
  status: Exclude<ProbeStatus, { kind: 'idle' } | { kind: 'running' }>;
}): ReactElement {
  const tone =
    status.kind === 'signed_in' ? 'good' : status.kind === 'signed_out' ? 'bad' : 'neutral';
  const headline =
    status.kind === 'signed_in'
      ? 'Signed in — the banner will clear after the next run.'
      : status.kind === 'signed_out'
        ? 'Still signed out.'
        : status.kind === 'cli_missing'
          ? 'CLI not found on PATH.'
          : 'Could not determine sign-in state.';
  return (
    <div className={`runner-login-card-probe runner-login-card-probe-${tone}`}>
      <div className="runner-login-card-probe-headline">{headline}</div>
      {status.detail ? <div className="runner-login-card-probe-detail">{status.detail}</div> : null}
    </div>
  );
}
