import { getGithub } from '../../github/client';
import { ObeliskError } from '../../../shared/errors';

/**
 * Fetch the GitHub login of an issue's author. Used by every agent that
 * applies the actor-allowlist gate to a backlog-driven task.
 *
 * Returns null when there's no issue number, or when the API doesn't
 * surface a login (deleted user). Throws AUTH_REQUIRED if the user is
 * not signed in.
 */
export async function fetchIssueAuthor(
  repoFullName: string,
  issueNumber: number | null,
): Promise<string | null> {
  const ctx = await fetchIssueContext(repoFullName, issueNumber);
  return ctx?.author ?? null;
}

export interface IssueContext {
  author: string | null;
  state: 'open' | 'closed';
  locked: boolean;
  /** Lowercased GitHub logins assigned to the issue. Used by the cross-installation guard. */
  assignees: string[];
  /** Label names present on the issue. */
  labels: string[];
}

/**
 * Richer companion to `fetchIssueAuthor`: also returns the issue's state,
 * locked flag, assignees, and labels so selectTask paths can short-circuit
 * on (a) closed/locked issues and (b) issues a sibling Obelisk install is
 * already working without doing additional API calls. Returns null for
 * missing issue numbers.
 */
export async function fetchIssueContext(
  repoFullName: string,
  issueNumber: number | null,
): Promise<IssueContext | null> {
  if (!issueNumber) return null;
  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before running agents.');
  }
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) return null;
  const resp = await gh.issues.get({ owner, repo: name, issue_number: issueNumber });
  return {
    author: resp.data.user?.login?.toLowerCase() ?? null,
    state: resp.data.state === 'closed' ? 'closed' : 'open',
    locked: Boolean(resp.data.locked),
    assignees: (resp.data.assignees ?? [])
      .map((a) => a?.login?.toLowerCase())
      .filter((s): s is string => typeof s === 'string' && s.length > 0),
    labels: (resp.data.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
      .filter((s) => s.length > 0),
  };
}
