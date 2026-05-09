import { getGithub } from '../../github/client';
import { OBELISK_LABELS } from '../../publisher/labels';
import { getAuthedLogin } from '../../auth/token-store';
import { appendAudit } from '../../logger/audit';
import type { Repo } from '../../../shared/types';

export interface PostClaimSignalInput {
  repo: Repo;
  /** Issue number on GitHub. Skip the call if this is null. */
  issueNumber: number | null | undefined;
  /** Stable reference for audit logging, e.g. `issue#142`. */
  source: string;
}

/**
 * Apply the GitHub-side "this issue is taken" signal at claim time so external
 * observers (teammates, second Obelisk installs, webhooks) see the claim
 * immediately, instead of waiting until the PR opens 30s–5min later.
 *
 * Two signals: assign the issue to the connected user AND apply
 * `obelisk:in-progress`. Both are idempotent — the publisher's existing
 * label-add at PR-open is a defense-in-depth no-op.
 *
 * Best-effort: any failure is logged via `appendAudit kind='claim_signal_failed'`
 * and never aborts the run. The local DB lock is the actual safety boundary;
 * this call exists for visibility only.
 */
export async function postClaimSignal(input: PostClaimSignalInput): Promise<void> {
  if (!input.issueNumber) return;

  const gh = await getGithub();
  if (!gh) return;
  const [owner, name] = input.repo.githubFullName.split('/');
  if (!owner || !name) return;

  const login = await getAuthedLogin().catch(() => null);

  await gh.issues
    .addLabels({
      owner,
      repo: name,
      issue_number: input.issueNumber,
      labels: [OBELISK_LABELS.inProgress],
    })
    .catch((e: unknown) => {
      appendAudit({
        runId: 'system',
        kind: 'claim_signal_failed',
        payload: {
          source: input.source,
          step: 'addLabels',
          error: e instanceof Error ? e.message : String(e),
        },
      });
    });

  if (login) {
    await gh.issues
      .addAssignees({
        owner,
        repo: name,
        issue_number: input.issueNumber,
        assignees: [login],
      })
      .catch((e: unknown) => {
        appendAudit({
          runId: 'system',
          kind: 'claim_signal_failed',
          payload: {
            source: input.source,
            step: 'addAssignees',
            error: e instanceof Error ? e.message : String(e),
          },
        });
      });
  }
}
