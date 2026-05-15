import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { useClickOutside } from '../hooks/useClickOutside';
import type { PlaybookFile, PlaybookRegenMode } from '../../shared/types';
import { EmptyState } from '../ui/EmptyState';
import { showApiAlert } from '../state/alert-store';

export function Playbook(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [files, setFiles] = useState<PlaybookFile[]>([]);
  const [draft, setDraft] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [framework, setFramework] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contents, setContents] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenMode, setRegenMode] = useState<PlaybookRegenMode | null>(null);

  const refresh = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('playbook:get', { repoId: repo.id });
    if (!res.ok) return;
    setFiles(res.value.files);
    setDraft(res.value.draft);
    setGeneratedAt(res.value.generatedAt);
    setFramework(res.value.framework);
    if (!activePath && res.value.files.length > 0) {
      setActivePath(res.value.files[0]!.path);
      setContents(res.value.files[0]!.contents);
    }
  };

  async function regenerate(mode: PlaybookRegenMode): Promise<void> {
    if (!repo || regenMode) return;
    if (
      mode === 'deep' &&
      !confirm(
        'Deep regenerate spawns the default CLI runner against this repo. It can take several minutes and uses LLM tokens. Continue?',
      )
    ) {
      return;
    }
    if (dirty && !confirm('You have unsaved edits. Regenerating will discard them. Continue?')) {
      return;
    }
    setRegenMode(mode);
    const res = await window.obelisk.invoke('playbook:regenerate', {
      repoId: repo.id,
      mode,
    });
    setRegenMode(null);
    if (!res.ok) {
      showApiAlert(res.error, 'regenerate playbook');
      return;
    }
    setActivePath(null);
    setContents('');
    setDirty(false);
    await refresh();
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  const active = useMemo(
    () => files.find((f) => f.path === activePath) ?? null,
    [files, activePath],
  );

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="The QA Playbook editor lives per-repo. Connect a repo first."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }

  if (files.length === 0) {
    return (
      <EmptyState
        title="No QA Playbook yet"
        body={
          <>
            Obelisk usually bootstraps <span className="mono">qa/</span> on first connect. Generate
            one now from this repo.
          </>
        }
        action={{
          label: regenMode === 'quick' ? 'Generating…' : 'Generate playbook',
          icon: <Icon.Refresh size={13} />,
          onClick: () => void regenerate('quick'),
        }}
      />
    );
  }

  function pick(path: string): void {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const f = files.find((x) => x.path === path);
    if (!f) return;
    setActivePath(path);
    setContents(f.contents);
    setDirty(false);
  }

  async function save(): Promise<void> {
    if (!active) return;
    setSaving(true);
    const updated = files.map((f) => (f.path === active.path ? { ...f, contents } : f));
    const res = await window.obelisk.invoke('playbook:save', {
      repoId: repo!.id,
      files: updated,
    });
    setSaving(false);
    if (!res.ok) {
      showApiAlert(res.error, 'save playbook');
      return;
    }
    setFiles(updated);
    setDirty(false);
  }

  return (
    <div className="playbook-screen">
      <aside className="playbook-files">
        <div className="row gap-2" style={{ padding: '4px 8px 6px', alignItems: 'center' }}>
          <Icon.Playbook size={13} color="var(--brand)" />
          <span style={{ fontSize: 12, fontWeight: 600 }}>QA Playbook</span>
          {draft ? (
            <span
              className="pill"
              style={{ marginLeft: 'auto' }}
              title="Edits are cached locally and not yet committed to the repo. Raise the safety mode to publish."
            >
              draft
            </span>
          ) : null}
        </div>
        <div
          className="playbook-meta"
          title={
            generatedAt
              ? `Last sync: ${new Date(generatedAt).toLocaleString()}`
              : 'No sync recorded yet — run Regenerate to bootstrap.'
          }
        >
          <span>Last sync: {formatRelative(generatedAt)}</span>
          {framework ? <span className="muted">framework: {framework}</span> : null}
        </div>
        <RegenerateMenu busy={regenMode} onPick={(mode) => void regenerate(mode)} />
        <div className="playbook-files-list">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`playbook-file-button${f.path === activePath ? ' selected' : ''}`}
              onClick={() => pick(f.path)}
            >
              {basename(f.path)}
            </button>
          ))}
        </div>
      </aside>

      <div className="playbook-editor">
        <div className="playbook-toolbar">
          <span className="playbook-toolbar-path">{active?.path ?? ''}</span>
          <div className="row gap-2">
            {dirty ? (
              <span className="muted" style={{ fontSize: 11 }}>
                unsaved
              </span>
            ) : null}
            <button
              type="button"
              className="btn primary sm"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <textarea
          className="playbook-textarea"
          value={contents}
          onChange={(e) => {
            setContents(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'never';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const REGEN_BUSY_LABELS: Record<PlaybookRegenMode, string> = {
  quick: 'Regenerating…',
  deep: 'Deep regenerating…',
};

function RegenerateMenu({
  busy,
  onPick,
}: {
  busy: PlaybookRegenMode | null;
  onPick: (mode: PlaybookRegenMode) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(open, wrapRef, () => setOpen(false));

  const label = busy ? REGEN_BUSY_LABELS[busy] : 'Regenerate';

  return (
    <div ref={wrapRef} className="playbook-regen">
      <button
        type="button"
        className="btn sm"
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
        title="Re-generate the QA playbook from this repo"
      >
        <Icon.Refresh size={11} /> {label}
        <Icon.ChevronDown size={9} style={{ marginLeft: 4 }} />
      </button>
      {open && busy === null ? (
        <div role="menu" className="playbook-regen-pop">
          <button
            type="button"
            role="menuitem"
            className="playbook-regen-item"
            onClick={() => {
              setOpen(false);
              onPick('quick');
            }}
          >
            <div className="playbook-regen-item-title">Quick regenerate</div>
            <div className="playbook-regen-item-sub">
              Re-runs heuristics (file tree + framework sniff). Free, instant.
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="playbook-regen-item"
            onClick={() => {
              setOpen(false);
              onPick('deep');
            }}
          >
            <div className="playbook-regen-item-title">Deep regenerate</div>
            <div className="playbook-regen-item-sub">
              Spawns the default runner to read the codebase and write real content. Costs LLM
              tokens; takes minutes.
            </div>
          </button>
        </div>
      ) : null}
    </div>
  );
}
