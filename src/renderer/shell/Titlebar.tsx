import type { ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { ObeliskMark } from './Obelisk';

export function Titlebar(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const lastHeartbeat = useStore((s) => s.lastHeartbeat);
  const repo = repos.find((r) => r.id === selectedRepoId);

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <ObeliskMark size={14} />
        <span className="titlebar-brand">Obelisk</span>

        <button type="button" className="titlebar-search" disabled>
          <Icon.Search size={11} color="var(--t-2)" />
          <span className="titlebar-search-text">Search or run command…</span>
          <span className="kbd titlebar-kbd">⌘K</span>
        </button>
      </div>

      <div className="titlebar-right">
        {lastHeartbeat ? (
          <span className="titlebar-heartbeat" title={`bus heartbeat: ${lastHeartbeat}`}>
            <span className="dot live" style={{ background: 'var(--ok)', color: 'var(--ok)' }} />
            bus connected
          </span>
        ) : (
          <span className="titlebar-heartbeat muted">bus pending…</span>
        )}

        <button type="button" className="btn titlebar-repo" disabled>
          <Icon.GitHub size={12} color="var(--t-1)" />
          <span style={{ color: 'var(--t-1)' }}>{repo ? repo.githubFullName : 'no repo'}</span>
          <Icon.ChevronDown size={11} color="var(--t-2)" />
        </button>

        <button
          type="button"
          className="btn icon titlebar-run"
          title="Run all agents now (Phase 4)"
          disabled
        >
          <Icon.Play size={11} color="var(--t-1)" />
        </button>
      </div>
    </header>
  );
}
