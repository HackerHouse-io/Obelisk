import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { loadGitHubToken } from '../auth/token-store';

const ObeliskOctokit = Octokit.plugin(retry, throttling);

let cachedToken: string | null = null;
let cachedClient: Octokit | null = null;

/**
 * Get an Octokit client authenticated with the user's stored token.
 * Returns null if the user is signed out.
 *
 * Throttling: the @octokit/plugin-throttling plugin handles secondary
 * rate-limit + abuse-detection automatically. We log every API call to
 * audit_log via the request hook.
 */
export async function getGithub(): Promise<Octokit | null> {
  const stored = await loadGitHubToken();
  if (!stored) {
    cachedToken = null;
    cachedClient = null;
    return null;
  }
  if (cachedClient && cachedToken === stored.token) return cachedClient;

  const client = new ObeliskOctokit({
    auth: stored.token,
    userAgent: 'obelisk-app/0.0.1',
    // E2E + integration tests point Octokit at a local stub HTTP server
    // by setting OBELISK_GITHUB_BASE_URL. In production the env var is
    // unset and Octokit falls back to its built-in api.github.com base.
    ...(process.env['OBELISK_GITHUB_BASE_URL']
      ? { baseUrl: process.env['OBELISK_GITHUB_BASE_URL'] }
      : {}),
    retry: {
      doNotRetry: [400, 401, 403, 404, 422],
    },
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.warn(
          `[github] rate limit on ${options.method} ${options.url}; retry in ${retryAfter}s (count=${retryCount})`,
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        console.warn(
          `[github] secondary rate limit on ${options.method} ${options.url}; pausing ${retryAfter}s`,
        );
        return true;
      },
    },
  });

  // Hook every request for audit-log purposes (Phase 2 only logs to
  // console; Phase 4 wires this into a proper run-scoped audit row).
  client.hook.before('request', (options) => {
    const url = `${options.method} ${options.url}`;
    console.log(`[github] -> ${url}`);
  });
  client.hook.after('request', (response, options) => {
    console.log(
      `[github] <- ${options.method} ${options.url} ${response.status} (${response.headers['x-ratelimit-remaining'] ?? '?'} remaining)`,
    );
  });
  client.hook.error('request', (error, options) => {
    // Removing a label that isn't on an issue returns 404 "Label does not
    // exist". Call sites do this idempotently (e.g. publish() strips both
    // possible trigger labels, clearClaimSignals() removes in-progress
    // regardless of whether it was applied) and swallow the rejection. It's
    // an expected no-op, not a failure — log it quietly so it doesn't read
    // as an error in the audit stream. We still re-throw so the call-site
    // .catch() sees it.
    const status = (error as { status?: number }).status;
    const isBenignLabelRemoval =
      status === 404 && options.method === 'DELETE' && /\/labels\//.test(String(options.url));
    if (isBenignLabelRemoval) {
      console.log(`[github] <- ${options.method} ${options.url} 404 (label already absent)`);
    } else {
      console.error(`[github] !! ${options.method} ${options.url}:`, error);
    }
    throw error;
  });

  cachedToken = stored.token;
  cachedClient = client;
  return client;
}

/** Force a re-read of the token on next getGithub() call. */
export function invalidateGithubClient(): void {
  cachedToken = null;
  cachedClient = null;
}
