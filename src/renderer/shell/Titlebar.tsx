import { useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import { ObeliskMark } from './Obelisk';
import { CommandPalette } from '../ui/CommandPalette';
import { RepoSwitcher } from '../ui/RepoSwitcher';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { showApiAlert } from '../state/alert-store';

export function Titlebar(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const lastHeartbeat = useStore((s) => s.lastHeartbeat);
  const setRoute = useStore((s) => s.setRoute);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [noRepoPromptOpen, setNoRepoPromptOpen] = useState(false);

  // Global ⌘K / Ctrl+K toggles the palette regardless of route or repo state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function runDefault(): Promise<void> {
    if (!repo) {
      setNoRepoPromptOpen(true);
      return;
    }
    const res = await runAgentByName(repo.id, 'bug-fixer');
    if (!res.ok) showApiAlert(res.error, 'start run');
  }

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <ObeliskMark size={14} />
        <span className="titlebar-brand">Obelisk</span>

        <button
          type="button"
          className="titlebar-search"
          onClick={() => setPaletteOpen(true)}
          title="Search or run a command (⌘K)"
        >
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

        <div className="titlebar-repo-wrap">
          <button
            type="button"
            className="btn titlebar-repo"
            onClick={() => setSwitcherOpen((o) => !o)}
            title={repo ? 'Switch repo' : 'Connect a repo'}
          >
            <Icon.GitHub size={12} color="var(--t-1)" />
            <span style={{ color: 'var(--t-1)' }}>{repo ? repo.githubFullName : 'no repo'}</span>
            <Icon.ChevronDown size={11} color="var(--t-2)" />
          </button>
          <RepoSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
        </div>

        <button
          type="button"
          className="btn icon titlebar-run"
          onClick={runDefault}
          title={repo ? 'Run Bug Fixer now' : 'Connect a repo to run agents'}
        >
          <Icon.Play size={11} color="var(--t-1)" />
        </button>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      <ConfirmDialog
        open={noRepoPromptOpen}
        title="Connect a repo first"
        body={
          <>
            Bug Fixer needs a connected GitHub repo to run against. Pick one in the Connect wizard
            and run again.
          </>
        }
        cancelLabel="Not now"
        confirmLabel="Connect a repo"
        confirmIcon="Connect"
        onCancel={() => setNoRepoPromptOpen(false)}
        onConfirm={() => {
          setNoRepoPromptOpen(false);
          setRoute('connect');
        }}
      />
    </header>
  );
}
