import { app } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { listRepos, getRepo, getRepoByFullName, createRepo, setRepoMode } from '../db/repos';
import { createAgent } from '../db/agents';
import { addToAllowlist } from '../db/allowlist';
import { getGithub } from '../github/client';
import { loadGitHubToken } from '../auth/token-store';
import { bootstrapAndPublish } from '../agents/playbook-bootstrapper/publish';
import { ObeliskError } from '../../shared/errors';
import type { AgentName, IpcMap } from '../../shared/types';

const DEFAULT_AGENTS: AgentName[] = [
  'qa-hunter',
  'manual-qa',
  'bug-fixer',
  'feature-builder',
  'pr-reviewer',
  'ios-qa-pilot',
];

export async function handleReposList(): Promise<IpcMap['repos:list']['res']> {
  return listRepos();
}

/**
 * Connect a repo. Two modes:
 *   - localPath only: validate it's a git repo, parse origin to derive owner/name
 *   - githubFullName only: clone into <userData>/repos/<owner>/<name> and connect
 *
 * Both paths default to mode='observe', runner='claude', and seed the
 * five default agents + a single actor_allowlist entry for the connected
 * GitHub account.
 */
export async function handleReposConnect(
  payload: IpcMap['repos:connect']['req'],
): Promise<IpcMap['repos:connect']['res']> {
  let localPath = payload.localPath ?? '';
  let githubFullName = payload.githubFullName ?? '';
  let defaultBranch = 'main';

  if (localPath) {
    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
      throw new ObeliskError(
        'NOT_FOUND',
        `Local path does not exist or is not a directory: ${localPath}`,
      );
    }
    const git = simpleGit(localPath);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      throw new ObeliskError(
        'INVALID_INPUT',
        `Path is not a git repository: ${localPath}`,
        'Pick the root of a checked-out clone, or clone via the GitHub option instead.',
      );
    }
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    if (!origin?.refs.fetch) {
      throw new ObeliskError(
        'INVALID_INPUT',
        'No origin remote found.',
        'Configure `git remote add origin <github url>` in the repo first.',
      );
    }
    const parsed = parseGitHubRemote(origin.refs.fetch);
    if (!parsed) {
      throw new ObeliskError(
        'INVALID_INPUT',
        `Origin remote is not a github.com URL: ${origin.refs.fetch}`,
      );
    }
    githubFullName = parsed.fullName;
    const branchSummary = await git.branch(['-r']);
    defaultBranch = pickDefaultBranch(branchSummary.all) ?? 'main';
  } else if (githubFullName) {
    const [owner, name] = githubFullName.split('/');
    if (!owner || !name) {
      throw new ObeliskError('INVALID_INPUT', `Invalid GitHub full name: ${githubFullName}`);
    }
    const stored = await loadGitHubToken();
    if (!stored) {
      throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before cloning a repo.');
    }
    const dest = join(app.getPath('userData'), 'repos', owner, name);
    if (existsSync(dest)) {
      throw new ObeliskError(
        'CONFLICT',
        `Destination already exists: ${dest}`,
        'Pick the existing local path instead, or remove the directory first.',
      );
    }
    const cloneUrl = `https://x-access-token:${stored.token}@github.com/${githubFullName}.git`;
    await simpleGit().clone(cloneUrl, dest);
    localPath = dest;
    const git = simpleGit(localPath);
    const branchSummary = await git.branch(['-r']);
    defaultBranch = pickDefaultBranch(branchSummary.all) ?? 'main';
  } else {
    throw new ObeliskError('INVALID_INPUT', 'Provide localPath or githubFullName.');
  }

  const existing = getRepoByFullName(githubFullName);
  if (existing) {
    throw new ObeliskError('CONFLICT', `${githubFullName} is already connected.`);
  }

  const repo = createRepo({
    githubFullName,
    localPath,
    defaultBranch,
    mode: 'observe',
    defaultRunner: 'claude',
  });

  for (const name of DEFAULT_AGENTS) {
    createAgent({ repoId: repo.id, name });
  }

  // Auto-allowlist the connected user so their issues/PRs work day one.
  const stored = await loadGitHubToken();
  if (stored?.login) {
    addToAllowlist(repo.id, stored.login, 'auto');
  }

  // Fire the playbook bootstrapper. In Observe mode this writes a draft
  // to settings; in higher modes it pushes a `chore(obelisk): bootstrap
  // QA playbook` PR. Failures here are non-fatal — the connect succeeds
  // and the user can re-trigger the bootstrap manually from Settings.
  void bootstrapAndPublish(repo).catch((e) => {
    console.warn(`[obelisk] playbook bootstrap failed for ${repo.githubFullName}:`, e);
  });

  // Eagerly populate the backlog so the user's first Run-now click on
  // Bug Fixer / Feature Builder finds something to claim. Without this
  // they'd see "BACKLOG_EMPTY" until the periodic sweep fires (~2 min
  // after boot). Fire-and-forget — the bug-fixer's selectTask also
  // syncs inline as a fallback.
  void import('../scheduler/backlog-sync').then((m) =>
    m.syncBacklogForRepo(repo.id).catch((e: unknown) => {
      console.warn(
        `[obelisk] eager backlog sync failed for ${repo.githubFullName}:`,
        e instanceof Error ? e.message : String(e),
      );
    }),
  );

  return repo;
}

export async function handleReposSetMode(
  payload: IpcMap['repos:setMode']['req'],
): Promise<IpcMap['repos:setMode']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  return setRepoMode(payload.repoId, payload.mode);
}

/**
 * Read or update the per-repo bug-fixer / feature-builder knobs. The
 * concurrency cap and merge-queue toggle are real product settings;
 * we do NOT gate the agent's diff (no file-count cap, no path
 * blacklist) — Claude Code / Codex decides what to touch.
 */
export async function handleReposBugFixerSettings(
  payload: IpcMap['repos:bugFixerSettings']['req'],
): Promise<IpcMap['repos:bugFixerSettings']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const scope = `repo:${payload.repoId}` as const;
  const { getSetting, setSetting } = await import('../db/settings');

  if (payload.patch) {
    if (payload.patch.mergeQueueEnabled !== undefined) {
      setSetting(scope, 'merge_queue_enabled', payload.patch.mergeQueueEnabled);
    }
    if (payload.patch.cap !== undefined) {
      setSetting(scope, 'bug_fixer_cap', payload.patch.cap);
    }
  }

  return {
    mergeQueueEnabled: getSetting<boolean>(scope, 'merge_queue_enabled') ?? false,
    cap: getSetting<number>(scope, 'bug_fixer_cap') ?? 3,
  };
}

/**
 * List the connected user's GitHub repos so the wizard can offer a
 * clone-from-GitHub flow without making the user paste a URL.
 */
export async function handleReposListGitHubRepos(): Promise<
  IpcMap['repos:listGitHubRepos']['res']
> {
  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub first.');
  }
  // Up to 100 most recently pushed repos. Wizard UI paginates client-side.
  const { data } = await gh.repos.listForAuthenticatedUser({
    sort: 'pushed',
    per_page: 100,
  });
  return data.map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? 'main',
    private: r.private,
    description: r.description,
  }));
}

/* ---------- internals ---------- */

function parseGitHubRemote(url: string): { fullName: string } | null {
  // Supported: https://github.com/owner/name(.git)?, git@github.com:owner/name(.git)?
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (httpsMatch) return { fullName: `${httpsMatch[1]}/${httpsMatch[2]}` };
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) return { fullName: `${sshMatch[1]}/${sshMatch[2]}` };
  return null;
}

function pickDefaultBranch(remoteBranches: string[]): string | null {
  // Prefer origin/main, then origin/master, otherwise the first branch.
  const candidates = ['origin/main', 'origin/master'];
  for (const c of candidates) {
    if (remoteBranches.includes(c)) return c.replace(/^origin\//, '');
  }
  const first = remoteBranches[0];
  if (!first) return null;
  return first.replace(/^origin\//, '');
}
