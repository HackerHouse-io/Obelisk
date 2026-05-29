import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { ErrorCode } from '../../shared/errors';
import type { Run } from '../../shared/types';
import { Icon } from '../icons';
import { labelForAgent } from '../format';
import { retryRun } from '../lib/retry-run';

interface Props {
  open: boolean;
  run: Run | null;
  onClose: () => void;
  /** Fires after a successful retry so the parent can close its drawer state. */
  onRetried?: () => void;
}

interface PostState {
  status: 'idle' | 'sending' | 'sent' | 'error';
  error?: { code: ErrorCode; message: string; hint?: string };
}

/**
 * Shown when a Bug Fixer run paused with REPRO_FAILED — the agent investigated
 * but couldn't confirm the bug and needs the missing spec/repro from a human.
 * Mirrors FileIssueModal's shape: surfaces what the agent found, collects a
 * free-text clarification, and on submit re-runs the task with that text
 * threaded into the prompt (and posted as a GitHub issue comment). If the
 * agent still can't confirm, the new run re-pauses and the user lands here
 * again.
 */
export function SpecClarificationModal({
  open,
  run,
  onClose,
  onRetried,
}: Props): ReactElement | null {
  const [text, setText] = useState('');
  const [post, setPost] = useState<PostState>({ status: 'idle' });
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setPost({ status: 'idle' });
    queueMicrotask(() => areaRef.current?.focus());
  }, [open, run?.id]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
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

  if (!open || !run) return null;

  const issueRef = run.taskRef ?? 'this task';
  const finding =
    run.outputSummary?.trim() || 'The agent could not reproduce or confirm the reported bug.';

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!run || post.status === 'sending') return;
    const clarification = text.trim();
    if (!clarification) return;
    setPost({ status: 'sending' });
    const res = await retryRun(run, clarification);
    if (!res.ok) {
      setPost({ status: 'error', error: res.error });
      return;
    }
    setPost({ status: 'sent' });
    onRetried?.();
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
        className="modal-panel spec-clarify-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spec-clarify-head">
          <div className="spec-clarify-icon" aria-hidden="true">
            <Icon.Help size={16} />
          </div>
          <div className="spec-clarify-head-text">
            <div className="spec-clarify-title">Clarify the spec for {issueRef}</div>
            <div className="spec-clarify-sub">
              {labelForAgent(run.agentName)} couldn’t confirm this bug on its own
            </div>
          </div>
          <button
            type="button"
            className="btn ghost icon"
            onClick={onClose}
            disabled={sending}
            title="Close"
          >
            <Icon.Close size={11} />
          </button>
        </div>

        <div className="spec-clarify-finding">
          <div className="spec-clarify-finding-label">What the agent found</div>
          <div className="spec-clarify-finding-body">{finding}</div>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <label className="spec-clarify-field-label" htmlFor="spec-clarify-input">
            Add the missing repro steps, expected behavior, or spec
          </label>
          <textarea
            id="spec-clarify-input"
            ref={areaRef}
            className="spec-clarify-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. The paywall SHOULD read “WealthLab+” — confirmed by product. Repro: open Settings → Upgrade on a fresh install."
            rows={6}
            disabled={sending || sent}
          />
          <div className="spec-clarify-hint">
            This is posted as a comment on the GitHub issue and given to the agent on the retry.
          </div>

          {post.status === 'error' && post.error ? (
            <div className="spec-clarify-error" role="alert">
              {post.error.message}
              {post.error.hint ? (
                <div className="spec-clarify-error-hint">{post.error.hint}</div>
              ) : null}
            </div>
          ) : null}

          <div className="spec-clarify-actions">
            <button type="button" className="btn ghost sm" onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary sm"
              disabled={sending || sent || text.trim().length === 0}
            >
              {sending ? (
                <>
                  <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
                  Retrying…
                </>
              ) : sent ? (
                <>
                  <Icon.Check size={11} /> Retry started
                </>
              ) : (
                <>
                  <Icon.Refresh size={11} /> Provide details &amp; retry
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
