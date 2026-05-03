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
  if (!issueNumber) return null;
  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before running agents.');
  }
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) return null;
  const resp = await gh.issues.get({ owner, repo: name, issue_number: issueNumber });
  return resp.data.user?.login?.toLowerCase() ?? null;
}
