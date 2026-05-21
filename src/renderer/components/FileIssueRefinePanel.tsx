import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { PreviewedFinding, PreviewFollowup, RunnerKind } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { Icon } from '../icons';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type Availability =
  | { state: 'loading' }
  | { state: 'available'; runner: RunnerKind }
  | { state: 'unavailable'; runner: RunnerKind; reason: 'cli_missing' | 'signed_out' | 'unknown' };

interface Props {
  previewId: number;
  finding: PreviewedFinding;
  currentDraft: { title: string; labels: string[] };
  /** True when the user has typed into the body textarea — surfaces a confirm. */
  bodyDirty: boolean;
  onUpdated: (next: PreviewedFinding) => void;
  /** Read-only mode (archived runs) disables Send. */
  readOnly?: boolean;
}

export function FileIssueRefinePanel({
  previewId,
  finding,
  currentDraft,
  bodyDirty,
  onUpdated,
  readOnly = false,
}: Props): ReactElement {
  const [availability, setAvailability] = useState<Availability>({ state: 'loading' });
  const [messages, setMessages] = useState<PreviewFollowup[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ code: ErrorCode; message: string; hint?: string } | null>(
    null,
  );
  const [confirmDirty, setConfirmDirty] = useState(false);
  const [reverting, setReverting] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Monotonic local counter for optimistic message ids — guarantees
  // uniqueness even on rapid sends (Date.now() would collide within ms).
  const optimisticIdRef = useRef(0);

  // Initial transcript fetch + pre-flight probe.
  useEffect(() => {
    let cancelled = false;
    void window.obelisk.invoke('previews:listFollowups', { previewId }).then((res) => {
      if (cancelled || !res.ok) return;
      setMessages(res.value.messages);
    });
    void window.obelisk.invoke('previews:refineAvailable', { previewId }).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setAvailability({ state: 'unavailable', runner: 'claude', reason: 'unknown' });
        return;
      }
      if (res.value.ok) {
        setAvailability({ state: 'available', runner: res.value.runner });
      } else {
        setAvailability({
          state: 'unavailable',
          runner: res.value.runner,
          reason: res.value.reason,
        });
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [previewId]);

  // Live updates: the assistant reply arrives via `previews.followupChanged`
  // after the refine handler appends it. Refetch the transcript on every
  // signal targeting this preview.
  useEffect(() => {
    return window.obelisk.subscribe((evt) => {
      if (evt.type !== 'previews.followupChanged') return;
      if (evt.previewId !== previewId) return;
      void window.obelisk.invoke('previews:listFollowups', { previewId }).then((res) => {
        if (res.ok) setMessages(res.value.messages);
      });
    });
  }, [previewId]);

  // Keep the transcript scrolled to the latest message.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, sending]);

  const canSend = useMemo(() => {
    if (readOnly) return false;
    if (sending) return false;
    if (input.trim().length === 0) return false;
    if (availability.state !== 'available') return false;
    if (finding.published) return false;
    return true;
  }, [readOnly, sending, input, availability, finding.published]);

  const hasTranscript = messages.length > 0;

  async function dispatchRefine(): Promise<void> {
    const userMessage = input.trim();
    if (!userMessage) return;
    setSending(true);
    setError(null);
    setInput('');
    // Optimistic append so the user sees their bubble immediately;
    // the bus subscriber will overwrite on completion with the real row.
    optimisticIdRef.current -= 1;
    const optimistic: PreviewFollowup = {
      id: optimisticIdRef.current,
      previewId,
      role: 'user',
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    const res = await window.obelisk.invoke('previews:refine', {
      previewId,
      currentDraft,
      userMessage,
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error);
      // Roll back the optimistic message so the user can edit and retry.
      setMessages((m) => m.filter((row) => row.id !== optimistic.id));
      setInput(userMessage);
      return;
    }
    onUpdated(res.value.updated);
  }

  async function handleSend(): Promise<void> {
    if (!canSend) return;
    if (bodyDirty) {
      setConfirmDirty(true);
      return;
    }
    await dispatchRefine();
  }

  async function handleRevert(): Promise<void> {
    if (reverting || sending) return;
    setReverting(true);
    setError(null);
    const res = await window.obelisk.invoke('previews:revertFollowups', { previewId });
    setReverting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessages([]);
    if (res.value.restored) onUpdated(res.value.restored);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="refine-panel">
      <div className="refine-transcript" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="refine-empty">
            Disagree with the framing? Tell the agent what to change — the title, severity, expected
            behavior, or which file is wrong. The draft will update in place before you file it.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`refine-message refine-message-${m.role}`}>
              {m.content}
            </div>
          ))
        )}
        {sending ? (
          <div className="refine-message refine-message-assistant refine-message-typing">
            <span className="refine-dot" />
            <span className="refine-dot" />
            <span className="refine-dot" />
          </div>
        ) : null}
      </div>

      {availability.state === 'unavailable' ? (
        <div className="refine-banner">
          <Icon.AlertTri size={11} /> {unavailableLabel(availability)}
        </div>
      ) : null}
      {error ? (
        <div className="refine-banner refine-banner-error">
          <Icon.AlertTri size={11} /> {errorLabel(error)}
        </div>
      ) : null}

      <div className="refine-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            availability.state === 'available'
              ? 'Tell the agent what to change…  (⌘/Ctrl + Enter to send)'
              : 'Refine unavailable'
          }
          className="refine-input"
          rows={3}
          disabled={!canSend && availability.state !== 'available'}
        />
        <div className="refine-actions">
          {hasTranscript ? (
            <button
              type="button"
              className="btn ghost refine-revert"
              onClick={() => void handleRevert()}
              disabled={reverting || sending}
              title="Discard refinements and restore the original finding"
            >
              {reverting ? 'Reverting…' : 'Revert to original'}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn primary refine-send"
            onClick={() => void handleSend()}
            disabled={!canSend}
          >
            {sending ? (
              <>
                <Icon.Spinner size={12} /> Refining…
              </>
            ) : (
              <>
                <Icon.GitHub size={12} /> Send
              </>
            )}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDirty}
        title="Replace your manual edits?"
        body="You’ve edited the body directly. Refining will regenerate it from the structured finding, so your manual edits will be lost."
        cancelLabel="Keep editing"
        confirmLabel="Replace and refine"
        onCancel={() => setConfirmDirty(false)}
        onConfirm={() => {
          setConfirmDirty(false);
          void dispatchRefine();
        }}
      />
    </div>
  );
}

function unavailableLabel(a: Extract<Availability, { state: 'unavailable' }>): string {
  if (a.reason === 'cli_missing') {
    return `${a.runner} CLI is not on PATH. Refine is disabled until you install it.`;
  }
  if (a.reason === 'signed_out') {
    return `${a.runner} is signed out. Run \`${a.runner} login\` in a terminal to refine.`;
  }
  return `Couldn't verify ${a.runner} sign-in. Refine is disabled.`;
}

function errorLabel(err: { code: ErrorCode; message: string; hint?: string }): string {
  if (err.code === 'FINDINGS_NOT_PARSEABLE') {
    return "The model didn't return a clean update. Try a shorter, more direct message.";
  }
  if (err.code === 'RUNNER_LOGIN_REQUIRED') {
    return 'The coding-agent CLI is signed out. Run `claude login` or `codex login` and retry.';
  }
  return err.hint ? `${err.message} — ${err.hint}` : err.message;
}
