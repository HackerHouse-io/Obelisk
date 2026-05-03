import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import type { PlaybookFile } from '../../shared/types';

export function Playbook(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [files, setFiles] = useState<PlaybookFile[]>([]);
  const [draft, setDraft] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contents, setContents] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('playbook:get', { repoId: repo.id });
    if (!res.ok) return;
    setFiles(res.value.files);
    setDraft(res.value.draft);
    if (!activePath && res.value.files.length > 0) {
      setActivePath(res.value.files[0]!.path);
      setContents(res.value.files[0]!.contents);
    }
  };

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
      <div className="placeholder">
        <div className="placeholder-title">No repo connected</div>
        <div className="placeholder-body">Open Connect Repo first.</div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">No QA Playbook yet</div>
        <div className="placeholder-body">
          Connect a repo and Obelisk will bootstrap <span className="mono">qa/</span> for you.
          Re-run from Settings if you skipped that step.
        </div>
      </div>
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
      alert(res.error.message);
      return;
    }
    setFiles(updated);
    setDirty(false);
  }

  return (
    <div className="playbook-screen">
      <aside className="playbook-files">
        <div className="row gap-2" style={{ padding: '4px 8px 8px', alignItems: 'center' }}>
          <Icon.Playbook size={13} color="var(--brand)" />
          <span style={{ fontSize: 12, fontWeight: 600 }}>QA Playbook</span>
          {draft ? (
            <span className="pill" style={{ marginLeft: 'auto' }}>
              draft
            </span>
          ) : null}
        </div>
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
