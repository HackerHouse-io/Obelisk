import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Tiny in-process stub of api.github.com for the e2e harness. Implements
 * just the endpoints the bug-fixer touches:
 *
 *   GET  /user
 *   GET  /repos/:owner/:repo/issues
 *   GET  /repos/:owner/:repo/issues/:num
 *   POST /repos/:owner/:repo/issues/:num/labels
 *   POST /repos/:owner/:repo/issues/:num/assignees
 *   DEL  /repos/:owner/:repo/issues/:num/labels/:name
 *   DEL  /repos/:owner/:repo/issues/:num/assignees
 *   GET  /repos/:owner/:repo/pulls
 *   GET  /repos/:owner/:repo/pulls/:num
 *   GET  /repos/:owner/:repo/commits/:sha/check-runs
 *   POST /repos/:owner/:repo/pulls
 *
 * Unknown routes return 404 + record the call so tests can inspect.
 *
 * Set Octokit at this server by exporting `OBELISK_GITHUB_BASE_URL=<url>`.
 */
export interface GithubStubIssue {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  user?: { login: string };
  labels?: { name: string }[];
  assignees?: { login: string }[];
  pull_request?: { url: string };
  body?: string;
  draft?: boolean;
  locked?: boolean;
}

export interface GithubStubOptions {
  /** Login returned by GET /user — defaults to "obelisk-test-user". */
  authedLogin?: string;
  /** Issues returned by GET issues + addressable via GET issues/:num. */
  issues?: GithubStubIssue[];
}

interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

export interface GithubStubHandle {
  baseUrl: string;
  server: Server;
  /** Every observed request, in arrival order. Tests assert on this. */
  requests: RequestRecord[];
  /** Live mutable view of issues so handlers can update labels/assignees. */
  issues: Map<number, GithubStubIssue>;
  /** Stop the server. */
  close: () => Promise<void>;
}

export async function startGithubStub(opts: GithubStubOptions = {}): Promise<GithubStubHandle> {
  const requests: RequestRecord[] = [];
  const issues = new Map<number, GithubStubIssue>();
  for (const i of opts.issues ?? []) {
    issues.set(i.number, {
      ...i,
      state: i.state ?? 'open',
      labels: i.labels ?? [],
      assignees: i.assignees ?? [],
    });
  }
  const authedLogin = opts.authedLogin ?? 'obelisk-test-user';

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';
    requests.push({ method, path, body });

    // GET /user
    if (method === 'GET' && path === '/user') {
      return json(res, 200, { login: authedLogin, id: 999, type: 'User' });
    }

    // GET /users/:login — used by allowlist:add to verify the login exists.
    // The stub accepts any non-empty username so tests can drive the
    // allowlist UX without curating a fake user database.
    const getUser = path.match(/^\/users\/([^/?#]+)/);
    if (method === 'GET' && getUser) {
      const login = decodeURIComponent(getUser[1]!);
      return json(res, 200, { login, id: 1234, type: 'User' });
    }

    // GET /repos/:owner/:repo/issues?state=open&labels=...
    const listIssuesMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues(?:\?|$)/);
    if (method === 'GET' && listIssuesMatch) {
      const url = new URL(path, 'http://stub');
      const labelFilter = url.searchParams.get('labels');
      const arr = [...issues.values()].filter((i) => {
        if (labelFilter && !i.labels?.some((l) => l.name === labelFilter)) return false;
        return true;
      });
      return json(res, 200, arr);
    }

    // GET /repos/:owner/:repo/issues/:num
    const getIssue = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
    if (method === 'GET' && getIssue) {
      const num = Number(getIssue[1]);
      const issue = issues.get(num);
      if (!issue) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, issue);
    }

    // POST /repos/:owner/:repo/issues/:num/labels
    const addLabels = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/);
    if (method === 'POST' && addLabels) {
      const num = Number(addLabels[1]);
      const issue = issues.get(num);
      if (!issue) return json(res, 404, { message: 'Not Found' });
      const incoming = (body as { labels?: string[] })?.labels ?? [];
      issue.labels = dedupeBy(
        [...(issue.labels ?? []), ...incoming.map((name) => ({ name }))],
        (l) => l.name,
      );
      return json(res, 200, issue.labels);
    }

    // POST /repos/:owner/:repo/issues/:num/assignees
    const addAssignees = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/assignees$/);
    if (method === 'POST' && addAssignees) {
      const num = Number(addAssignees[1]);
      const issue = issues.get(num);
      if (!issue) return json(res, 404, { message: 'Not Found' });
      const incoming = (body as { assignees?: string[] })?.assignees ?? [];
      issue.assignees = dedupeBy(
        [...(issue.assignees ?? []), ...incoming.map((login) => ({ login }))],
        (a) => a.login,
      );
      return json(res, 200, issue);
    }

    // DELETE /repos/:owner/:repo/issues/:num/labels/:name
    const removeLabel = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/(.+)$/);
    if (method === 'DELETE' && removeLabel) {
      const num = Number(removeLabel[1]);
      const labelName = decodeURIComponent(removeLabel[2]!);
      const issue = issues.get(num);
      if (!issue) return json(res, 404, { message: 'Not Found' });
      issue.labels = (issue.labels ?? []).filter((l) => l.name !== labelName);
      return json(res, 200, issue.labels);
    }

    // DELETE /repos/:owner/:repo/issues/:num/assignees
    if (method === 'DELETE' && addAssignees) {
      const num = Number(addAssignees[1]);
      const issue = issues.get(num);
      if (!issue) return json(res, 404, { message: 'Not Found' });
      const incoming = (body as { assignees?: string[] })?.assignees ?? [];
      issue.assignees = (issue.assignees ?? []).filter((a) => !incoming.includes(a.login));
      return json(res, 200, issue);
    }

    // GET /repos/:owner/:repo/pulls (auto-merge / rebase / ci-retry sweeps)
    const listPulls = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls(?:\?|$)/);
    if (method === 'GET' && listPulls) {
      return json(res, 200, []);
    }

    // GET /repos/:owner/:repo/pulls/:num
    const getPull = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (method === 'GET' && getPull) {
      return json(res, 404, { message: 'Not Found' });
    }

    // GET /repos/:owner/:repo/commits/:sha/check-runs
    const checks = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs(?:\?|$)/);
    if (method === 'GET' && checks) {
      return json(res, 200, { total_count: 0, check_runs: [] });
    }

    // Default: 404 + log it.
    return json(res, 404, { message: 'Not Found (stub)' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    server,
    requests,
    issues,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('etag', `"stub-${Date.now()}"`);
  res.end(JSON.stringify(body));
}

function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
