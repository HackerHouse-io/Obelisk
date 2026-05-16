import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../icons';

interface Entry {
  name: string;
  isDir: boolean;
  isHidden: boolean;
}

interface Props {
  open: boolean;
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}

/**
 * Branded folder picker. Navigates an absolute path on disk via the
 * `fs:listDir` IPC. The "selected" path is whatever directory the user
 * is currently viewing — confirming returns that path. Mirrors the
 * macOS folder picker mental model without the macOS chrome.
 */
export function FolderPickerDialog({
  open,
  title,
  confirmLabel,
  onCancel,
  onConfirm,
}: Props): ReactElement | null {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (next: string | null, hidden: boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    const res = await window.obelisk.invoke('fs:listDir', {
      ...(next ? { path: next } : {}),
      showHidden: hidden,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setPath(res.value.path);
    setParent(res.value.parent);
    setEntries(res.value.entries);
  }, []);

  // Reset to $HOME each time the dialog opens; closing wipes state.
  useEffect(() => {
    if (open) {
      setShowHidden(false);
      void load(null, false);
    } else {
      setPath(null);
      setParent(null);
      setEntries([]);
      setError(null);
    }
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && path) {
        e.preventDefault();
        onConfirm(path);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm, path]);

  if (!open) return null;

  const segments = path ? splitPath(path) : [];

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-panel folder-picker"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="folder-picker-header">
          <div className="modal-title">{title}</div>
          <button
            type="button"
            className="btn ghost icon"
            onClick={onCancel}
            aria-label="Close"
            title="Close"
          >
            <Icon.Close size={11} />
          </button>
        </div>

        <div className="folder-picker-pathbar">
          <button
            type="button"
            className="btn ghost sm icon"
            onClick={() => parent && void load(parent, showHidden)}
            disabled={!parent || loading}
            title={parent ? `Up to ${parent}` : 'At filesystem root'}
            aria-label="Go up"
          >
            <Icon.ArrowLeft size={11} />
          </button>
          <div className="folder-picker-breadcrumbs" title={path ?? ''}>
            {segments.map((seg, i) => {
              const upTo = joinSegments(segments.slice(0, i + 1));
              const isLast = i === segments.length - 1;
              return (
                <span key={`${upTo}-${i}`} className="folder-picker-crumb">
                  <button
                    type="button"
                    className={`folder-picker-crumb-btn${isLast ? ' current' : ''}`}
                    disabled={isLast || loading}
                    onClick={() => void load(upTo, showHidden)}
                    title={upTo}
                  >
                    {seg.label}
                  </button>
                  {!isLast ? <span className="folder-picker-crumb-sep">/</span> : null}
                </span>
              );
            })}
          </div>
        </div>

        <div className="folder-picker-list" role="listbox">
          {loading ? (
            <div className="folder-picker-empty">Loading…</div>
          ) : error ? (
            <div className="folder-picker-empty folder-picker-error">{error}</div>
          ) : entries.length === 0 ? (
            <div className="folder-picker-empty">
              No subfolders here. Use “{confirmLabel}” to pick this folder.
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.name}
                type="button"
                className="folder-picker-row"
                onDoubleClick={() => void load(joinPath(path, e.name), showHidden)}
                onClick={() => void load(joinPath(path, e.name), showHidden)}
                title={`Open ${e.name}`}
              >
                <Icon.Folder size={12} />
                <span className="folder-picker-row-name">{e.name}</span>
                <Icon.Chevron size={9} />
              </button>
            ))
          )}
        </div>

        <div className="folder-picker-footer">
          <label className="folder-picker-hidden-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked);
                void load(path, e.target.checked);
              }}
            />
            <span>Show hidden</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => path && onConfirm(path)}
              disabled={!path || loading}
              autoFocus
            >
              <Icon.Check size={11} />
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function splitPath(absolute: string): { label: string }[] {
  if (absolute === '/') return [{ label: '/' }];
  const parts = absolute.split('/').filter(Boolean);
  return [{ label: '/' }, ...parts.map((p) => ({ label: p }))];
}

function joinSegments(segments: { label: string }[]): string {
  if (segments.length === 0) return '/';
  if (segments.length === 1) return '/';
  const rest = segments.slice(1).map((s) => s.label);
  return '/' + rest.join('/');
}

function joinPath(base: string | null, name: string): string {
  if (!base) return name;
  return base === '/' ? `/${name}` : `${base}/${name}`;
}
