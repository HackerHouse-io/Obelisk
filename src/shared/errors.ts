/**
 * Closed enum of error codes that can flow across the IPC boundary.
 * The renderer maps codes to user-facing messages; new codes are added
 * here first so they're known to both processes.
 */
export const ERROR_CODES = [
  'INTERNAL',
  'NOT_IMPLEMENTED',
  'AUTH_REQUIRED',
  'AUTH_DENIED',
  'TOKEN_EXPIRED',
  'MODE_TOO_LOW',
  'RUNNER_NOT_INSTALLED',
  'EVIDENCE_INCOMPLETE',
  'REPRO_FAILED',
  'PUSH_REJECTED',
  'TIMEOUT',
  'TEST_LOOP_EXHAUSTED',
  'SPEC_AMBIGUOUS',
  'TEST_RUNNER_MISSING',
  'ACTOR_NOT_ALLOWLISTED',
  'REPO_NOT_FOUND',
  'AGENT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'INVALID_INPUT',
  'IO',
  'NOT_FOUND',
  'CONFLICT',
  'AGENT_SINGLETON',
  'AGENT_BUSY',
  'RUN_ACTIVE',
  'TEST_PLAN_REQUIRED',
  'RUNNER_NO_OUTPUT',
  'RUNNER_LOGIN_REQUIRED',
  'FINDINGS_NOT_PARSEABLE',
  'IOS_QA_NOT_CONFIGURED',
  'IOS_QA_SETUP_REQUIRED',
  'IOS_QA_NO_FLOWS',
  'IOS_QA_NOTHING_CLAIMABLE',
  'IOS_QA_POOL_FULL',
  'IOS_QA_APPIUM_FAILED',
  'IOS_QA_BUILD_FAILED',
  'BACKLOG_EMPTY',
  'BACKLOG_ALL_FILTERED',
  'PATCH_AGENT_CAP_REACHED',
  'WORKTREE_BUSY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ObeliskError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ObeliskError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: { code: ErrorCode; message: string; hint?: string } };
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(code: ErrorCode, message: string, hint?: string): Err {
  return { ok: false, error: hint ? { code, message, hint } : { code, message } };
}

export function fromException(e: unknown): Err {
  if (e instanceof ObeliskError) {
    return err(e.code, e.message, e.hint);
  }
  if (e instanceof Error) {
    return err('INTERNAL', e.message);
  }
  return err('INTERNAL', String(e));
}
