import { create } from 'zustand';
import type { ErrorCode, Err } from '../../shared/errors';

export interface AlertPayload {
  title: string;
  body?: string;
  hint?: string;
  /** Optional — only used to choose a default title via titleForError. */
  code?: ErrorCode;
  confirmLabel?: string;
}

interface AlertStoreState {
  current: AlertPayload | null;
  show: (payload: AlertPayload) => void;
  dismiss: () => void;
}

export const useAlertStore = create<AlertStoreState>((set) => ({
  current: null,
  show: (payload) => set({ current: payload }),
  dismiss: () => set({ current: null }),
}));

/**
 * Imperative helper for code paths that don't want to call the hook
 * (event handlers, async callbacks). Mirrors the previous `alert()`
 * ergonomics — `showAlert({ title, body })` from anywhere.
 */
export function showAlert(payload: AlertPayload): void {
  useAlertStore.getState().show(payload);
}

/**
 * Convenience wrapper for the "if (!res.ok) alert(res.error.message)"
 * pattern. Picks a friendly title from the error code, surfaces the
 * IPC message + hint without forcing every caller to remember the
 * shape.
 *
 * Pass an optional `actionLabel` to use a verb-specific title prefix
 * (e.g. actionLabel: "stop run" → "Couldn't stop run").
 */
export function showApiAlert(error: Err['error'], actionLabel?: string): void {
  showAlert({
    title: titleForError(error.code, actionLabel),
    body: error.message,
    ...(error.hint ? { hint: error.hint } : {}),
    code: error.code,
  });
}

/**
 * Map an IPC error code to a short modal title. Codes without a
 * specific entry fall back to the action verb ("Couldn't <verb>") or
 * a generic "Something went wrong" if no verb was given.
 */
export function titleForError(code: ErrorCode, actionLabel?: string): string {
  switch (code) {
    case 'PATCH_AGENT_CAP_REACHED':
      return 'At the Bug Fixer limit';
    case 'BACKLOG_EMPTY':
      return 'No issues to fix';
    case 'BACKLOG_ALL_FILTERED':
      return 'Nothing claimable right now';
    case 'NO_OPEN_PRS':
      return 'No open pull requests';
    case 'PRS_ALL_FILTERED':
      return 'Nothing to review right now';
    case 'MODE_TOO_LOW':
      return 'Safety mode blocks this';
    case 'AUTH_REQUIRED':
    case 'TOKEN_EXPIRED':
      return 'Sign in to GitHub';
    case 'AUTH_DENIED':
      return 'GitHub access denied';
    case 'RUNNER_NOT_INSTALLED':
      return 'No coding-agent CLI installed';
    case 'RUNNER_LOGIN_REQUIRED':
      return 'Coding-agent CLI needs login';
    case 'RUN_ACTIVE':
      return 'A run is already active';
    case 'AGENT_BUSY':
      return 'Agent is busy';
    case 'AGENT_SINGLETON':
      return 'Only one instance allowed';
    case 'AGENT_NOT_FOUND':
    case 'RUN_NOT_FOUND':
    case 'REPO_NOT_FOUND':
    case 'NOT_FOUND':
      return 'Not found';
    case 'ACTOR_NOT_ALLOWLISTED':
      return 'Author not on the allowlist';
    case 'TEST_PLAN_REQUIRED':
      return 'Pick a test plan first';
    case 'INVALID_INPUT':
      return 'Invalid input';
    case 'TIMEOUT':
      return 'The run timed out';
    case 'CONFLICT':
      return 'Conflict';
    default:
      return actionLabel ? `Couldn't ${actionLabel}` : 'Something went wrong';
  }
}
