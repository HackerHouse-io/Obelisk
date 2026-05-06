import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { ErrorCode } from '../../shared/errors';
import type { PreviewedFinding } from '../../shared/types';
import { Icon } from '../icons';
import { labelForAgent, shortDate } from '../format';
import { EvidenceStrip } from './FindingPreview';

interface Props {
  open: boolean;
  finding: PreviewedFinding | null;
  onClose: () => void;
  /** Called after the issue is filed; parent should refresh its list. */
  onFiled: (issueNumber: number, htmlUrl: string) => void;
}

interface PostState {
  status: 'idle' | 'sending' | 'sent' | 'error';
  error?: { code: ErrorCode; message: string; hint?: string };
  issue?: { issueNumber: number; htmlUrl: string };
}

export function FileIssueModal({ open, finding, onClose, onFiled }: Props): ReactElement | null {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState('');
  const [bodyTab, setBodyTab] = useState<'edit' | 'preview'>('edit');
  const [post, setPost] = useState<PostState>({ status: 'idle' });
  const titleRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || !finding) return;
    setTitle(finding.title);
    setBody(finding.body);
    setLabels(finding.labels);
    setLabelDraft('');
    setBodyTab('edit');
    setPost({ status: 'idle' });
    queueMicrotask(() => titleRef.current?.focus());
  }, [open, finding]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && post.status !== 'sending') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, post.status]);

  const reproSummary = useMemo(() => extractReproSummary(body), [body]);

  if (!open || !finding) return null;

  function addLabel(raw: string): void {
    const v = raw.trim().replace(/^#/, '');
    if (!v) return;
    if (labels.includes(v)) {
      setLabelDraft('');
      return;
    }
    setLabels([...labels, v]);
    setLabelDraft('');
  }

  function onLabelKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addLabel(labelDraft);
    } else if (e.key === 'Backspace' && labelDraft === '' && labels.length > 0) {
      e.preventDefault();
      setLabels(labels.slice(0, -1));
    }
  }

  function removeLabel(l: string): void {
    setLabels(labels.filter((x) => x !== l));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!finding || !title.trim() || post.status === 'sending') return;
    setPost({ status: 'sending' });
    const res = await window.obelisk.invoke('previews:fileIssue', {
      previewId: finding.id,
      title: title.trim(),
      body,
      labels,
    });
    if (!res.ok) {
      setPost({ status: 'error', error: res.error });
      return;
    }
    setPost({ status: 'sent', issue: res.value });
    onFiled(res.value.issueNumber, res.value.htmlUrl);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 900);
  }

  const sending = post.status === 'sending';
  const sent = post.status === 'sent';

  return (
    <div className="modal-overlay" onClick={() => post.status !== 'sending' && onClose()}>
      <div
        className="modal-panel file-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-label="File issue on GitHub"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <header className="file-issue-header">
            <div className="file-issue-headline">
              <Icon.GitHub size={14} color="var(--t-1)" />
              <span className="file-issue-title-text">File issue on GitHub</span>
              {finding.severity ? (
                <span className={`pill sev-${finding.severity.toLowerCase()}`}>
                  {finding.severity}
                </span>
              ) : null}
            </div>
            <div className="file-issue-meta">
              {labelForAgent(finding.agentName)} · {shortDate(finding.at)}
              {reproSummary ? ` · ${reproSummary}` : ''}
            </div>
            <button
              type="button"
              className="btn ghost icon file-issue-close"
              onClick={onClose}
              disabled={sending}
              aria-label="Close"
            >
              <Icon.Close size={11} />
            </button>
          </header>

          <div className="file-issue-grid">
            <div className="file-issue-fields">
              <label className="file-issue-label">
                <span>Title</span>
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="file-issue-input"
                  placeholder="A short, descriptive title"
                  disabled={sending || sent}
                  required
                />
              </label>

              <label className="file-issue-label">
                <span>Labels</span>
                <div className="file-issue-labels">
                  {labels.map((l) => (
                    <span key={l} className="pill file-issue-chip">
                      {l}
                      <button
                        type="button"
                        className="file-issue-chip-x"
                        onClick={() => removeLabel(l)}
                        disabled={sending || sent}
                        aria-label={`Remove label ${l}`}
                      >
                        <Icon.Close size={9} />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={onLabelKey}
                    onBlur={() => labelDraft && addLabel(labelDraft)}
                    placeholder={labels.length === 0 ? 'Add label and press Enter' : ''}
                    className="file-issue-label-input"
                    disabled={sending || sent}
                  />
                </div>
              </label>

              <div className="file-issue-label">
                <div className="file-issue-tabs">
                  <span>Body</span>
                  <button
                    type="button"
                    className={`file-issue-tab${bodyTab === 'edit' ? ' active' : ''}`}
                    onClick={() => setBodyTab('edit')}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`file-issue-tab${bodyTab === 'preview' ? ' active' : ''}`}
                    onClick={() => setBodyTab('preview')}
                  >
                    Preview
                  </button>
                </div>
                {bodyTab === 'edit' ? (
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="file-issue-textarea"
                    spellCheck
                    disabled={sending || sent}
                  />
                ) : (
                  <pre className="file-issue-preview">{body}</pre>
                )}
              </div>
            </div>

            <aside className="file-issue-evidence">
              <div className="file-issue-evidence-title">Evidence</div>
              {finding.evidence.length === 0 ? (
                <div className="file-issue-evidence-empty">
                  No screenshots or recordings captured for this run.
                </div>
              ) : (
                <EvidenceStrip finding={finding} />
              )}
            </aside>
          </div>

          {post.status === 'error' && post.error ? (
            <div className="file-issue-error">
              <Icon.AlertTri size={11} /> {errorMessageFor(post.error)}
            </div>
          ) : null}
          {sent && post.issue ? (
            <div className="file-issue-success">
              <Icon.Check size={11} /> Filed as #{post.issue.issueNumber}
            </div>
          ) : null}

          <div className="modal-actions file-issue-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={!title.trim() || sending || sent}
            >
              {sending ? (
                <>
                  <Icon.Spinner size={12} /> Sending…
                </>
              ) : sent ? (
                <>
                  <Icon.Check size={12} /> Sent
                </>
              ) : (
                <>
                  <Icon.GitHub size={12} /> Send to GitHub
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function extractReproSummary(body: string): string | null {
  const m = body.match(
    /(?:^|\n)\s*(?:\*\*)?(?:Steps to reproduce|Repro)(?:\*\*)?[:\s]*\n([\s\S]*?)(?:\n\s*\n|$)/i,
  );
  if (!m || !m[1]) return null;
  const steps = m[1].split('\n').filter((l) => /^\s*(\d+\.|[-*])/.test(l)).length;
  if (steps === 0) return null;
  return `Repro: ${steps} step${steps === 1 ? '' : 's'}`;
}

function errorMessageFor(err: { code: ErrorCode; message: string; hint?: string }): string {
  if (err.code === 'AUTH_REQUIRED') return 'Sign in to GitHub before filing the issue.';
  if (err.code === 'CONFLICT') return err.message;
  return err.hint ? `${err.message} — ${err.hint}` : err.message;
}
