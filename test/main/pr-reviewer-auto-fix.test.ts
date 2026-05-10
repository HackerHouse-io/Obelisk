import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb, getDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { addToAllowlist } from '../../src/main/db/allowlist';
import { prReviewerHandler } from '../../src/main/agents/pr-reviewer';
import { ulid } from 'ulid';
import type { Repo, SafetyMode } from '../../src/shared/types';
import type { InterpretResultInput } from '../../src/main/agents/types';
import type { RunResult } from '../../src/main/runners/types';

// Mock Octokit at the module boundary. Each test rebinds the call surface
// it cares about; defaults below are no-ops that return empty responses.
const pullsList = vi.fn();
const pullsGet = vi.fn();
const issuesAddLabels = vi.fn().mockResolvedValue({ data: [] });
const issuesAddAssignees = vi.fn().mockResolvedValue({ data: {} });
const issuesRemoveLabel = vi.fn().mockResolvedValue({ data: [] });
const issuesRemoveAssignees = vi.fn().mockResolvedValue({ data: {} });

const fakeGh = {
  pulls: {
    list: pullsList,
    get: pullsGet,
  },
  issues: {
    addLabels: issuesAddLabels,
    addAssignees: issuesAddAssignees,
    removeLabel: issuesRemoveLabel,
    removeAssignees: issuesRemoveAssignees,
  },
};

vi.mock('../../src/main/github/client', () => ({
  getGithub: vi.fn(async () => fakeGh),
  invalidateGithubClient: vi.fn(),
}));

// loadGitHubToken returns the connected user's login. The PR Reviewer uses
// it to (a) auto-allow our own PRs, (b) write the cross-install assignee
// signature, (c) compare against assignees in the cross-install guard.
const CONNECTED_USER = 'obelisk-test-user';
vi.mock('../../src/main/auth/token-store', () => ({
  loadGitHubToken: vi.fn(async () => ({ login: CONNECTED_USER, token: 't' })),
  getAuthedLogin: vi.fn(async () => CONNECTED_USER),
  getStoredToken: vi.fn(async () => null),
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-prr-fix-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();

  pullsList.mockReset();
  pullsGet.mockReset();
  issuesAddLabels.mockClear();
  issuesAddAssignees.mockClear();
  issuesRemoveLabel.mockClear();
  issuesRemoveAssignees.mockClear();
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(mode: SafetyMode = 'prs'): Repo {
  return createRepo({
    githubFullName: 'test/auto-fix',
    localPath: '/tmp/unused-for-selecttask-tests',
    defaultBranch: 'main',
    mode,
    defaultRunner: 'claude',
  });
}

interface MockPrInput {
  number: number;
  headRef: string;
  headSha?: string;
  author?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

function mockPr(input: MockPrInput) {
  return {
    number: input.number,
    title: `PR #${input.number}`,
    body: input.body ?? 'A pull request.',
    user: { login: input.author ?? CONNECTED_USER },
    head: { ref: input.headRef, sha: input.headSha ?? `sha-${input.number}-aaaaaaaaaaaa` },
    labels: (input.labels ?? []).map((name) => ({ name })),
    assignees: (input.assignees ?? []).map((login) => ({ login })),
  };
}

function makeAgent(repoId: string): string {
  return createAgent({ repoId, name: 'pr-reviewer' }).id;
}

/**
 * Seed a completed `pr-reviewer` run row directly via SQL so the
 * livelock-cap query can count it. Mirrors what the orchestrator would
 * write at the end of a real successful run.
 */
function seedPriorReviewerRun(repoId: string, prNumber: number, headSha: string): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, repo_id, agent_name, agent_id, trigger, task_ref,
                         task_context, runner_used, state, started_at)
       VALUES (?, ?, 'pr-reviewer', NULL, 'schedule', ?, NULL, 'claude', 'done', ?)`,
    )
    .run(ulid(), repoId, `pr#${prNumber}@${headSha}`, new Date().toISOString());
}

/* ====================================================================== */
/* selectTask: fix-mode gating                                            */
/* ====================================================================== */

describe('pr-reviewer selectTask: fix-mode gating', () => {
  it('attaches to the PR branch when the head ref is `obelisk/...` and mode is `prs`', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 42,
          headRef: 'obelisk/run-XYZ',
          headSha: 'sha42aaaaaaaaaa',
          body: 'Bug Fixer PR.',
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    expect(selected).not.toBeNull();
    expect(selected!.attachToBranch).toEqual({
      branch: 'obelisk/run-XYZ',
      existingPrNumber: 42,
    });
    expect(selected!.task.context).toContain('FIX MODE');
  });

  it('does NOT attach for a human-authored PR (head ref does not start with `obelisk/`)', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    addToAllowlist(repo.id, 'someone-else', 'auto');
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 7,
          headRef: 'feature/login-fix',
          author: 'someone-else',
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    expect(selected).not.toBeNull();
    expect(selected!.attachToBranch).toBeUndefined();
    expect(selected!.task.context).toContain('REVIEW ONLY');
  });

  it('does NOT attach when repo mode is below `prs` (preflight safety guard)', async () => {
    const repo = makeRepo('observe');
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 99,
          headRef: 'obelisk/run-OBSERVE',
          headSha: 'sha99aaaaaaaaaa',
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    expect(selected).not.toBeNull();
    expect(selected!.attachToBranch).toBeUndefined();
    expect(selected!.task.context).toContain('REVIEW ONLY');
  });

  it('does NOT attach when 3+ prior pr-reviewer runs already completed against this PR (livelock cap)', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    seedPriorReviewerRun(repo.id, 42, 'sha-old-1aaa');
    seedPriorReviewerRun(repo.id, 42, 'sha-old-2aaa');
    seedPriorReviewerRun(repo.id, 42, 'sha-old-3aaa');
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 42,
          headRef: 'obelisk/run-FRESH',
          headSha: 'sha42newaaaaaaaa',
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'schedule' as 'claude',
      trigger: 'schedule',
      agentId,
    });

    expect(selected).not.toBeNull();
    expect(selected!.attachToBranch).toBeUndefined();
    expect(selected!.task.context).toContain('REVIEW ONLY');
  });
});

/* ====================================================================== */
/* selectTask: cross-install + claim signal                                */
/* ====================================================================== */

describe('pr-reviewer selectTask: cross-install signaling', () => {
  it('skips a PR that already has obelisk:in-progress AND the connected user as assignee', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 1,
          headRef: 'obelisk/run-OWNED-BY-OTHER',
          labels: ['obelisk:in-progress'],
          assignees: [CONNECTED_USER],
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    // Cross-install guard fires → no claim attempted, no PR returned.
    expect(selected).toBeNull();
    expect(issuesAddLabels).not.toHaveBeenCalled();

    // Audit row recorded.
    const auditRows = getDb()
      .prepare<[string], { kind: string; payload: string }>(
        `SELECT kind, payload FROM audit_log WHERE kind = ?`,
      )
      .all('cross_install_skipped');
    expect(auditRows).toHaveLength(1);
  });

  it('does NOT skip when the in-progress label is present but the connected user is NOT an assignee', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 2,
          headRef: 'obelisk/run-MINE',
          headSha: 'sha2aaaaaaaaaaaa',
          labels: ['obelisk:in-progress'],
          assignees: ['some-other-user'],
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    // Different user owns the in-progress signal → we proceed.
    expect(selected).not.toBeNull();
    expect(selected!.task.githubNumber).toBe(2);
  });

  it('applies the GitHub-side claim signal (label + assignee) after a successful claim', async () => {
    const repo = makeRepo('prs');
    const agentId = makeAgent(repo.id);
    pullsList.mockResolvedValue({
      data: [
        mockPr({
          number: 5,
          headRef: 'obelisk/run-CLAIM',
          headSha: 'sha5aaaaaaaaaaaa',
        }),
      ],
    });

    const selected = await prReviewerHandler.selectTask({
      repo,
      defaultRunner: 'claude',
      trigger: 'schedule',
      agentId,
    });

    expect(selected).not.toBeNull();
    expect(issuesAddLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        labels: ['obelisk:in-progress'],
      }),
    );
    expect(issuesAddAssignees).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        assignees: [CONNECTED_USER],
      }),
    );
  });
});

/* ====================================================================== */
/* interpretResult: verdict math                                          */
/* ====================================================================== */

const REVIEW_NO_HIGH_SEV = `BEGIN_PR_REVIEW
{
  "verdict": "COMMENT",
  "summary": "A couple of nits.",
  "findings": [
    { "axis": "design", "severity": "P2", "where": "src/x.ts:1", "note": "Could be cleaner." }
  ],
  "verdict_block": "## Verdict\\nConfidence: 0.9",
  "confidence": 0.9
}
END_PR_REVIEW`;

const REVIEW_WITH_P1 = `BEGIN_PR_REVIEW
{
  "verdict": "REQUEST_CHANGES",
  "summary": "There is a real bug.",
  "findings": [
    { "axis": "correctness", "severity": "P1", "where": "src/x.ts:42", "note": "Race condition." }
  ],
  "verdict_block": "## Verdict\\nConfidence: 0.8",
  "confidence": 0.8
}
END_PR_REVIEW`;

const COMPLETE_EVIDENCE_BODY = `## Evidence

### Tests

- \`patch\` — x

### Screenshots

- \`screenshot\` — y

### Logs

- \`log\` — z

### Reasoning

ok.`;

function interpretInput(opts: {
  diff: string;
  reasoning: string;
  prNumber: number;
  prBody: string;
  repo: Repo;
}): InterpretResultInput {
  const okResult: Extract<RunResult, { ok: true }> = {
    ok: true,
    patch: { diff: opts.diff, filesChanged: opts.diff ? ['src/x.ts'] : [] },
    testsRun: [],
    reasoning: opts.reasoning,
  };
  return {
    repo: opts.repo,
    task: {
      ref: `pr#${opts.prNumber}@aaaaaaaaaaaa`,
      kind: 'review',
      context: 'whatever',
      githubNumber: opts.prNumber,
    },
    runResult: okResult,
    runId: 'test-run-id',
  };
}

describe('pr-reviewer interpretResult: verdict + plan emission', () => {
  it('with fix-up diff and no P0/P1 remaining → APPROVE + pr plan FIRST + review plan', async () => {
    const repo = makeRepo('prs');
    pullsGet.mockResolvedValue({ data: { body: COMPLETE_EVIDENCE_BODY } });

    const plansOrPlan = await prReviewerHandler.interpretResult(
      interpretInput({
        diff: 'diff --git a/x b/x\n+fix\n',
        reasoning: REVIEW_NO_HIGH_SEV,
        prNumber: 10,
        prBody: COMPLETE_EVIDENCE_BODY,
        repo,
      }),
    );
    const plans = Array.isArray(plansOrPlan) ? plansOrPlan : [plansOrPlan];

    expect(plans).toHaveLength(2);
    expect(plans[0]!.kind).toBe('pr');
    expect(plans[1]!.kind).toBe('review');
    if (plans[1]!.kind !== 'review') throw new Error('unreachable');
    expect(plans[1]!.event).toBe('APPROVE');
    expect(plans[1]!.body).toContain('pushed fix-up commits');
  });

  it('with fix-up diff but a P1 still remains → COMMENT + pr plan still emitted', async () => {
    const repo = makeRepo('prs');
    pullsGet.mockResolvedValue({ data: { body: COMPLETE_EVIDENCE_BODY } });

    const plansOrPlan = await prReviewerHandler.interpretResult(
      interpretInput({
        diff: 'diff --git a/x b/x\n+partial fix\n',
        reasoning: REVIEW_WITH_P1,
        prNumber: 11,
        prBody: COMPLETE_EVIDENCE_BODY,
        repo,
      }),
    );
    const plans = Array.isArray(plansOrPlan) ? plansOrPlan : [plansOrPlan];

    expect(plans).toHaveLength(2);
    expect(plans[0]!.kind).toBe('pr');
    if (plans[1]!.kind !== 'review') throw new Error('unreachable');
    expect(plans[1]!.event).toBe('COMMENT');
    expect(plans[1]!.body).toContain('still need human attention');
  });

  it('with NO fix-up diff → only the review plan, original verdict preserved', async () => {
    const repo = makeRepo('prs');
    pullsGet.mockResolvedValue({ data: { body: COMPLETE_EVIDENCE_BODY } });

    const plansOrPlan = await prReviewerHandler.interpretResult(
      interpretInput({
        diff: '',
        reasoning: REVIEW_WITH_P1,
        prNumber: 12,
        prBody: COMPLETE_EVIDENCE_BODY,
        repo,
      }),
    );
    const plans = Array.isArray(plansOrPlan) ? plansOrPlan : [plansOrPlan];

    expect(plans).toHaveLength(1);
    expect(plans[0]!.kind).toBe('review');
    if (plans[0]!.kind !== 'review') throw new Error('unreachable');
    expect(plans[0]!.event).toBe('REQUEST_CHANGES'); // original verdict, untouched
  });

  it('Evidence-incomplete override wins even when fix-up commits were pushed', async () => {
    const repo = makeRepo('prs');
    // PR body has no `## Evidence` section.
    pullsGet.mockResolvedValue({ data: { body: '## Summary\nA fix.\n' } });

    const plansOrPlan = await prReviewerHandler.interpretResult(
      interpretInput({
        diff: 'diff --git a/x b/x\n+fix\n',
        reasoning: REVIEW_NO_HIGH_SEV,
        prNumber: 13,
        prBody: '## Summary\nA fix.\n',
        repo,
      }),
    );
    const plans = Array.isArray(plansOrPlan) ? plansOrPlan : [plansOrPlan];

    // PR plan still emitted (the fix-up commits are real and should be pushed).
    expect(plans).toHaveLength(2);
    expect(plans[0]!.kind).toBe('pr');
    if (plans[1]!.kind !== 'review') throw new Error('unreachable');
    expect(plans[1]!.event).toBe('REQUEST_CHANGES');
    expect(plans[1]!.body).toContain('Evidence Pack incomplete');
  });
});
