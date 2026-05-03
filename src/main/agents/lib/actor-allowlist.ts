import { isAllowlisted } from '../../db/allowlist';
import { appendAudit } from '../../logger/audit';

export interface AllowlistCheckInput {
  repoId: string;
  /** GitHub login of the issue/PR/comment author. */
  login: string;
  /** Stable reference for audit logging, e.g. "issue#142". */
  source: string;
  /** Run id to attribute the audit row to. Use 'system' if no run yet exists. */
  runId?: string;
}

export type AllowlistResult = { ok: true } | { ok: false; login: string; reason: string };

/**
 * Hard gate at selectTask time. Non-allowlisted authors are skipped with a
 * dedicated `kind='actor_skipped'` audit row so the user can see exactly
 * why an issue was ignored.
 *
 * This is the primary defense against drive-by prompt-injection on public
 * repos — see PLAN.md "Actor allowlist".
 */
export function checkActorAllowlist(input: AllowlistCheckInput): AllowlistResult {
  if (isAllowlisted(input.repoId, input.login)) return { ok: true };

  const reason = `actor @${input.login} is not on the allowlist for this repo`;
  appendAudit({
    runId: input.runId ?? 'system',
    kind: 'actor_skipped',
    payload: { login: input.login, source: input.source, reason },
  });
  return { ok: false, login: input.login, reason };
}
