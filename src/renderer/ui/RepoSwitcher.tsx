import { useEffect, useRef, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function RepoSwitcher({ open, onClose }: Props): ReactElement | null {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const selectRepo = useStore((s) => s.selectRepo);
  const setRoute = useStore((s) => s.setRoute);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // Defer attaching the click listener so the same click that opened us
    // doesn't immediately close us.
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="repo-switcher" ref={ref}>
      <div className="repo-switcher-label">Connected repos</div>
      {repos.length === 0 ? (
        <div className="repo-switcher-empty">No repos yet.</div>
      ) : (
        repos.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`repo-switcher-row${r.id === selectedRepoId ? ' active' : ''}`}
            onClick={() => {
              selectRepo(r.id);
              onClose();
            }}
          >
            <Icon.GitHub size={12} color="var(--t-1)" />
            <div className="repo-switcher-row-info">
              <div className="repo-switcher-row-name truncate">{r.githubFullName}</div>
              <div className="repo-switcher-row-mode">
                <span className="mono">{r.mode}</span> ·{' '}
                <span className="mono">{r.defaultRunner}</span>
              </div>
            </div>
            {r.id === selectedRepoId ? <Icon.Check size={12} color="var(--brand)" /> : null}
          </button>
        ))
      )}
      <div className="repo-switcher-divider" />
      <button
        type="button"
        className="repo-switcher-row connect"
        onClick={() => {
          setRoute('connect');
          onClose();
        }}
      >
        <Icon.Plus size={12} color="var(--brand)" />
        <span className="repo-switcher-row-name">Connect a new repo…</span>
      </button>
    </div>
  );
}
