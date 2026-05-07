import { useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import type { RunnerKind } from '../../shared/types';

/**
 * Sign-in instructions for each CLI runner. Both Claude Code and Codex
 * authenticate against their own backends and have to be signed in inside
 * a real terminal — we can't do it for them from inside the Electron app
 * (Claude's `/login` is an interactive REPL slash command). The best we
 * can do is tell the user the exact command and put it on their clipboard.
 */
const INSTRUCTIONS: Record<
  RunnerKind,
  { name: string; command: string; followUp: string; learnMore: string }
> = {
  claude: {
    name: 'Claude Code',
    command: 'claude',
    followUp:
      'When the REPL opens, type /login and follow the prompts. Close the REPL when you see "Logged in".',
    learnMore: 'https://docs.anthropic.com/claude-code',
  },
  codex: {
    name: 'Codex',
    command: 'codex login',
    followUp: 'Sign in with your OpenAI account in the browser window codex opens, then close it.',
    learnMore: 'https://platform.openai.com/docs/codex',
  },
};

interface Props {
  runner: RunnerKind;
  onRetry?: () => void;
  /** Compact = inline action card inside the failed-run drawer. Banner = top-of-app surface. */
  variant?: 'compact' | 'banner';
}

export function RunnerLoginActionCard({
  runner,
  onRetry,
  variant = 'compact',
}: Props): ReactElement {
  const info = INSTRUCTIONS[runner];
  const [copied, setCopied] = useState(false);

  function copy(): void {
    void navigator.clipboard.writeText(info.command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
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
        </div>
        <div className="runner-login-card-followup">{info.followUp}</div>
        {onRetry ? (
          <div className="runner-login-card-actions">
            <button type="button" className="btn primary sm" onClick={onRetry}>
              <Icon.Play size={11} /> I&rsquo;ve signed in — retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
