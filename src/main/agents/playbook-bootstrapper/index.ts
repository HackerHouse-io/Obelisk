import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Repo } from '../../../shared/types';

/**
 * Playbook bootstrapper (TECH_DESIGN.md §10).
 *
 * Phase 5 implements: framework detection + seeded-user discovery + qa/ file
 * generation. Live route crawling and Playwright probe-runs land in Phase 6
 * with Manual QA. Output is a set of in-memory files the caller writes to
 * either a draft store (Observe mode) or to the worktree before commit.
 */

export interface PlaybookFile {
  /** Path relative to repo root, e.g. `qa/critical-flows.md`. */
  path: string;
  contents: string;
}

export interface BootstrapInput {
  repo: Repo;
}

export interface BootstrapOutput {
  files: PlaybookFile[];
  framework: Framework;
  /** Discovered seed users (or proposed defaults if none found). */
  seedUsers: SeedUser[];
  /** Detected critical-flow seeds — used to scaffold one .flow.md per. */
  criticalFlows: string[];
}

export type Framework =
  | 'next'
  | 'react-router'
  | 'vite-react'
  | 'express'
  | 'fastify'
  | 'rails'
  | 'django'
  | 'fastapi'
  | 'unknown';

export interface SeedUser {
  role: string;
  email: string;
  password: string;
  /** True when we proposed defaults rather than reading them from the repo. */
  proposed: boolean;
}

export function bootstrapPlaybook(input: BootstrapInput): BootstrapOutput {
  const root = input.repo.localPath;
  const framework = detectFramework(root);
  const seedUsers = discoverSeedUsers(root);
  const criticalFlows = proposeCriticalFlows(framework);

  const productMap = renderProductMap(input.repo, framework, root);
  const flowsList = renderCriticalFlows(criticalFlows);
  const expected = renderExpectedBehavior(criticalFlows);
  const bugRules = renderBugRules();
  const nonBugs = renderNonBugs();
  const testUsers = renderTestUsers(seedUsers);

  const files: PlaybookFile[] = [
    { path: 'qa/product-map.md', contents: productMap },
    { path: 'qa/critical-flows.md', contents: flowsList },
    { path: 'qa/expected-behavior.md', contents: expected },
    { path: 'qa/bug-rules.md', contents: bugRules },
    { path: 'qa/non-bugs.md', contents: nonBugs },
    { path: 'qa/test-users.md', contents: testUsers },
  ];

  for (const flow of criticalFlows) {
    files.push({
      path: `qa/playwright/flows/${slugify(flow)}.flow.md`,
      contents: renderFlowStub(flow),
    });
  }

  return { files, framework, seedUsers, criticalFlows };
}

/* ---------- detection ---------- */

function detectFramework(root: string): Framework {
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('next' in deps) return 'next';
      if ('react-router' in deps || 'react-router-dom' in deps) return 'react-router';
      if ('vite' in deps && ('react' in deps || 'react-dom' in deps)) return 'vite-react';
      if ('fastify' in deps) return 'fastify';
      if ('express' in deps) return 'express';
    } catch {
      // ignore malformed package.json
    }
  }
  if (existsSync(join(root, 'Gemfile')) && existsSync(join(root, 'config/routes.rb')))
    return 'rails';
  if (existsSync(join(root, 'manage.py'))) return 'django';
  // FastAPI heuristic: requirements.txt mentioning fastapi
  if (existsSync(join(root, 'requirements.txt'))) {
    try {
      const reqs = readFileSync(join(root, 'requirements.txt'), 'utf8');
      if (/^fastapi\b/im.test(reqs)) return 'fastapi';
    } catch {
      // ignore
    }
  }
  return 'unknown';
}

function discoverSeedUsers(root: string): SeedUser[] {
  // Look for common seed-data locations. We intentionally don't parse them
  // (formats vary widely) — we just confirm the file exists and propose
  // sensible defaults the user can edit in `qa/test-users.md`.
  const candidates = [
    'seed.sql',
    'seeds/users.sql',
    'db/seeds.rb',
    'prisma/seed.ts',
    'prisma/seed.js',
    'fixtures/users.json',
  ];
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) {
      // Found seeds — propose two roles but flag that the user should fill
      // in real credentials from the seed file.
      return [
        {
          role: 'normal_user',
          email: 'normal@example.com',
          password: 'CHANGE_ME (see ' + rel + ')',
          proposed: true,
        },
        {
          role: 'admin_user',
          email: 'admin@example.com',
          password: 'CHANGE_ME (see ' + rel + ')',
          proposed: true,
        },
      ];
    }
  }
  return [
    {
      role: 'normal_user',
      email: 'normal@example.com',
      password: 'PLEASE_FILL_IN',
      proposed: true,
    },
    { role: 'admin_user', email: 'admin@example.com', password: 'PLEASE_FILL_IN', proposed: true },
  ];
}

function proposeCriticalFlows(framework: Framework): string[] {
  // Deterministic per-framework starter flows. Phase 6 + Manual QA enriches
  // these with discovered routes from a live crawl.
  const generic = ['Login', 'Sign up', 'Logout'];
  switch (framework) {
    case 'next':
    case 'react-router':
    case 'vite-react':
      return [...generic, 'Create main resource', 'Refresh keeps state'];
    case 'express':
    case 'fastify':
    case 'fastapi':
      return [
        'Authenticated request',
        'Unauthenticated request rejected',
        'Validation rejects bad input',
      ];
    case 'rails':
    case 'django':
      return [...generic, 'Create main resource', 'Edit main resource'];
    case 'unknown':
      return generic;
  }
}

/* ---------- rendering ---------- */

function renderProductMap(repo: Repo, framework: Framework, root: string): string {
  const readme = readFirst(root, ['README.md', 'README.markdown', 'readme.md']);
  const summary = readme ? readme.split('\n').slice(0, 12).join('\n') : '_(no README detected)_';
  return `# ${repo.githubFullName} — product map

_Generated by Obelisk on ${new Date().toISOString().slice(0, 10)}. Edit freely; subsequent runs will not overwrite._

**Detected framework:** \`${framework}\`

## What this product is

${summary}

## Top-level entry points

${listTopLevel(root)}
`;
}

function renderCriticalFlows(flows: string[]): string {
  const lines = flows.map(
    (f, i) => `${i + 1}. **${f}** — see \`qa/playwright/flows/${slugify(f)}.flow.md\``,
  );
  return `# Critical flows (in test priority order)

These flows MUST pass on every nightly Manual QA run. If any of these stay broken, ship is blocked.

${lines.join('\n')}

To add a flow, drop a new \`*.flow.md\` in \`qa/playwright/flows/\` and append it here.
`;
}

function renderExpectedBehavior(flows: string[]): string {
  const blocks = flows
    .map(
      (f) =>
        `## ${f}

- Happy path completes with no console errors and no failed network requests.
- Page state survives a hard refresh.
- (add product-specific expectations here)`,
    )
    .join('\n\n');
  return `# Expected behavior

What "correct" looks like, per critical flow. Manual QA compares actual against this file.

${blocks}
`;
}

function renderBugRules(): string {
  return `# Universal bug rules

These are always bugs, regardless of product:

- A button that does nothing when clicked.
- A blank screen after a successful navigation.
- An uncaught console error during a successful flow.
- A 5xx response on the happy path.
- A successful navigation followed by data loss on refresh.
- A "save" or "submit" handler that doesn't persist.

These rules apply even when this file is empty downstream — they're hard-coded into Manual QA's oracle.
`;
}

function renderNonBugs(): string {
  return `# Known non-bugs

When you close an Obelisk-filed issue with the \`obelisk:false-positive\` label, a rule for that case is appended here automatically (via PR for review).

Initial entries:

- Free-tier users see an upgrade modal on premium routes — by design.
- Stripe redirects to checkout.stripe.com on payment — expected external navigation.
`;
}

function renderTestUsers(users: SeedUser[]): string {
  const rows = users
    .map(
      (u) =>
        `- **${u.role}** — \`${u.email}\` / \`${u.password}\`${u.proposed ? ' _(please verify)_' : ''}`,
    )
    .join('\n');
  return `# Test users

Manual QA logs in as these accounts. Update credentials below to match your seed data.

${rows}

Add roles freely. Format: \`- **role_name** — \\\`email\\\` / \\\`password\\\`\`.
`;
}

function renderFlowStub(name: string): string {
  return `Flow: ${name}
Steps:
  1. Log in as normal_user
  2. (describe each step)
Expected:
  - (what counts as success)
  - No console errors
  - No failed network request
Tags: smoke, ${name.toLowerCase().includes('login') ? 'auth' : 'crud'}
`;
}

/* ---------- helpers ---------- */

function readFirst(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function listTopLevel(root: string): string {
  try {
    const entries = readdirSync(root)
      .filter((e) => !e.startsWith('.') && e !== 'node_modules')
      .map((e) => {
        const p = join(root, e);
        try {
          return statSync(p).isDirectory() ? `- \`${e}/\`` : `- \`${e}\``;
        } catch {
          return null;
        }
      })
      .filter((e): e is string => e !== null)
      .slice(0, 20);
    return entries.join('\n') || '_(no entries)_';
  } catch {
    return '_(unreadable)_';
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Test-only: list files relative to a root for assertions. */
export function _relativize(root: string, files: PlaybookFile[]): string[] {
  return files.map((f) => relative(root, f.path));
}
