import type { CSSProperties, ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { ObeliskMark } from './Obelisk';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function Titlebar(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const lastHeartbeat = useStore((s) => s.lastHeartbeat);
  const repo = repos.find((r) => r.id === selectedRepoId);

  return (
    <header className="titlebar" style={titlebarStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/*
          On macOS, Electron's `titleBarStyle: hiddenInset` already paints the
          system traffic lights inside the titlebar. We shift our content right
          to make room rather than drawing our own.
        */}
        <div style={{ width: isMac ? 76 : 0 }} />
        <ObeliskMark size={14} />
        <span style={{ fontWeight: 600, fontSize: 12.5, letterSpacing: 0.2 }}>Obelisk</span>

        <button type="button" className="btn" style={paletteTriggerStyle} disabled>
          <Icon.Search size={11} color="var(--t-2)" />
          <span style={{ flex: 1, textAlign: 'left' }}>Search or run command…</span>
          <span className="kbd" style={{ fontSize: 9.5 }}>
            ⌘K
          </span>
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {lastHeartbeat ? (
          <span
            className="row gap-2"
            style={{ fontSize: 10.5, color: 'var(--t-2)' }}
            title={`bus heartbeat: ${lastHeartbeat}`}
          >
            <span className="dot live" style={{ background: 'var(--ok)', color: 'var(--ok)' }} />
            bus connected
          </span>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--t-3)' }}>bus pending…</span>
        )}

        <button type="button" className="btn" style={{ height: 26, fontSize: 12 }} disabled>
          <Icon.GitHub size={12} color="var(--t-1)" />
          <span style={{ color: 'var(--t-1)' }}>{repo ? `${repo.githubFullName}` : 'no repo'}</span>
          <Icon.ChevronDown size={11} color="var(--t-2)" />
        </button>

        <button
          type="button"
          className="btn icon"
          style={{ height: 26, width: 26 }}
          title="Run all agents now (Phase 4)"
          disabled
        >
          <Icon.Play size={11} color="var(--t-1)" />
        </button>
      </div>
    </header>
  );
}

const titlebarStyle: CSSProperties = {
  background: 'linear-gradient(180deg, #14171f, #0f1116)',
};

const paletteTriggerStyle: CSSProperties = {
  height: 24,
  fontSize: 11.5,
  marginLeft: 16,
  padding: '0 8px',
  background: 'var(--bg-0)',
  color: 'var(--t-2)',
  minWidth: 220,
};
