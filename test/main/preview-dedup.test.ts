import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the GitHub client module so qa-hunter's findDuplicateIssue path
// (which calls getGithub() → keytar) can't reach the real keychain in test.
// getGithub() returns null and findDuplicateIssue returns null fast.
vi.mock('../../src/main/github/client', () => ({
  getGithub: async () => null,
}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, setDbPathForTesting } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { createRepo } from '../../src/main/db/repos';
import { createAgent } from '../../src/main/db/agents';
import { createRun } from '../../src/main/db/runs';
import {
  insertPreview,
  listAllPreviewTitlesForRepo,
  listOpenPreviewTitlesForRepo,
  listPreviewsForRepo,
  markPreviewDismissed,
} from '../../src/main/db/previews';
import {
  previewTitleConflicts,
  titleConflicts,
} from '../../src/main/agents/lib/find-existing-issue';
import { qaHunterHandler } from '../../src/main/agents/qa-hunter';
import type { InterpretResultInput } from '../../src/main/agents/types';
import type { Repo } from '../../src/shared/types';

let tmp: string;
let repoId: string;
let repo: Repo;
let runId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-dedup-'));
  setDbPathForTesting(join(tmp, 'obelisk.sqlite'));
  runMigrations();
  repo = createRepo({
    githubFullName: 'test/dedup',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
  });
  repoId = repo.id;
  const agent = createAgent({ repoId, name: 'qa-hunter' });
  const run = createRun({
    repoId,
    agentName: 'qa-hunter',
    agentId: agent.id,
    trigger: 'manual',
    taskRef: 'plan:T1',
    runnerUsed: 'claude',
  });
  runId = run.id;
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('previewTitleConflicts', () => {
  it('matches identical titles ignoring different bracket prefixes', () => {
    expect(
      previewTitleConflicts(
        '[bug] Reset progress leaves streak state behind',
        '[bug] Reset progress leaves streak state behind',
      ),
    ).toBe(true);
  });

  it('matches across different prefixes (qa-hunter vs manual-qa)', () => {
    expect(
      previewTitleConflicts(
        '[bug] Reset progress leaves streak state behind',
        '[QA Bug] Reset progress leaves streak state behind',
      ),
    ).toBe(true);
  });

  it('matches via substring containment in either direction', () => {
    expect(
      previewTitleConflicts(
        '[bug] Reset progress leaves streak state behind',
        '[bug] Reset progress leaves streak',
      ),
    ).toBe(true);
    expect(
      previewTitleConflicts(
        '[bug] Reset progress',
        '[bug] Reset progress leaves streak state behind',
      ),
    ).toBe(true);
  });

  it('does not match unrelated titles', () => {
    expect(
      previewTitleConflicts(
        '[bug] Reset progress leaves streak state behind',
        "[bug] Dean's List never awards credentials for lesson-based courses",
      ),
    ).toBe(false);
  });

  it('returns false for empty / whitespace-only titles after stripping', () => {
    expect(previewTitleConflicts('[bug]', '[bug] real title')).toBe(false);
    expect(previewTitleConflicts('[bug] real title', '[bug]   ')).toBe(false);
  });

  it('does not regress titleConflicts (single-prefix variant)', () => {
    expect(
      titleConflicts(
        '[QA Bug] checkout fails on Stripe redirect',
        '[QA Bug] Checkout Fails on Stripe Redirect',
        '[QA Bug]',
      ),
    ).toBe(true);
  });

  it('matches near-duplicates that differ only by a stop word — the prod regression', () => {
    // Production repro: QA Hunter filed both of these on consecutive runs
    // because the substring check failed on "can never" vs "never".
    expect(
      previewTitleConflicts(
        "[bug] Lesson-only courses never earn Dean's List credentials",
        "[bug] Lesson-only courses can never earn Dean's List credentials",
      ),
    ).toBe(true);
  });

  it('matches near-duplicates with light stem differences (node/nodes, open/opens) — second prod regression', () => {
    // Production repro #2. After stop-word filtering ("only", "of") and
    // stem ("opens"→"open", "nodes"→"node"):
    //   A: home, capstone, node, open, story, player, instead, workshop  (8)
    //   B: home, capstone, path, node, open, read, story, instead, workshop  (9)
    // Intersection = 7, Union = 10, Jaccard = 0.7 → meets threshold.
    expect(
      previewTitleConflicts(
        '[bug] Home capstone path node opens read-only story instead of workshop',
        '[bug] Home capstone nodes open the story player instead of the workshop',
      ),
    ).toBe(true);
  });

  it('does not falsely match unrelated bugs that share generic vocabulary', () => {
    // Both mention "Profile" + "progress" but describe different
    // problems. The threshold should prevent collapsing them into one.
    expect(
      previewTitleConflicts(
        '[bug] Profile overall progress mixes story completions into a lesson-only denominator',
        '[bug] Profile Overall progress can render numerator over denominator after any story or case',
      ),
    ).toBe(false);
  });
});

describe('listOpenPreviewTitlesForRepo', () => {
  function writePreview(title: string): void {
    insertPreview({
      repoId,
      runId,
      agentName: 'qa-hunter',
      payload: { kind: 'issue', title, body: 'body', labels: ['obelisk:fix', 'P1'] },
    });
  }

  it('returns titles of preview rows with no published/dismissed marker', () => {
    writePreview('[bug] First issue');
    writePreview('[bug] Second issue');
    expect(listOpenPreviewTitlesForRepo(repoId)).toEqual(
      expect.arrayContaining(['[bug] First issue', '[bug] Second issue']),
    );
  });

  it('returns empty when there are no previews', () => {
    expect(listOpenPreviewTitlesForRepo(repoId)).toEqual([]);
  });

  it('does not include previews from other repos', () => {
    writePreview('[bug] In repo A');
    const otherRepo = createRepo({
      githubFullName: 'test/other',
      localPath: tmp,
      defaultBranch: 'main',
      mode: 'observe',
      defaultRunner: 'claude',
    });
    expect(listOpenPreviewTitlesForRepo(otherRepo.id)).toEqual([]);
  });
});

describe('qa-hunter interpretResult dedups against open previews', () => {
  function writePreview(title: string): void {
    insertPreview({
      repoId,
      runId,
      agentName: 'qa-hunter',
      payload: { kind: 'issue', title, body: 'body', labels: ['obelisk:fix', 'P1'] },
    });
  }

  function fakeInput(reasoning: string): InterpretResultInput {
    return {
      repo,
      task: { ref: 'plan:T1', kind: 'sweep', context: '', assignedPlan: undefined },
      runResult: {
        ok: true as const,
        patch: { diff: '', filesChanged: [] },
        testsRun: [],
        reasoning,
      },
      runId,
    };
  }

  function findingFixture(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      title: 'Reset progress leaves streak state behind',
      severity: 'P1',
      description:
        'Tapping Reset clears progress and credentials but the streak counter survives, so the home screen still shows a non-zero streak after a full reset.',
      expected: 'After Reset, the streak counter shows 0.',
      actual: 'After Reset, the streak counter shows its prior value.',
      repro: '1. Tap reset. 2. Check the streak counter — it is unchanged.',
      evidence: 'AppState.reset() never assigns streak = 0.',
      suspected_files: ['src/streak.ts'],
      suggested_test: 'expect streak to be 0 after reset',
      ...overrides,
    };
  }

  it('skips a finding whose title matches an existing open preview', async () => {
    writePreview('[bug] Reset progress leaves streak state behind');
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([findingFixture({})])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(0);
  });

  it('files findings whose titles do not match any open preview', async () => {
    writePreview('[bug] Reset progress leaves streak state behind');
    const finding = findingFixture({
      title: 'School hub stays English after switching to Spanish',
      severity: 'P0',
      description:
        'Switching the app locale to Spanish updates most screens, but the School hub component reads the cached locale on mount and never resubscribes, so it stays English until the app is restarted.',
      expected: 'School hub renders Spanish strings after the user switches locale to Spanish.',
      actual:
        'School hub renders English strings after switching to Spanish until the app is restarted.',
      repro:
        '1. Switch language to Spanish. 2. Tab away. 3. Come back to school hub — strings are still English.',
      suspected_files: ['src/i18n.ts'],
      suggested_test: 'expect locale to propagate to school hub',
    });
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([finding])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(1);
    expect((out[0] as { title: string }).title).toContain('School hub stays English');
  });

  it('within-batch dedup: two findings with the same title only file once', async () => {
    const a = findingFixture({});
    const b = findingFixture({ title: 'reset progress LEAVES streak state behind' });
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([a, b])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(1);
  });

  it('skips a finding that fuzzy-matches an existing preview only by a stop word', async () => {
    // The exact production repro: stored title differs only by "can".
    writePreview("[bug] Lesson-only courses never earn Dean's List credentials");
    const finding = findingFixture({
      title: "Lesson-only courses can never earn Dean's List credentials",
      severity: 'P1',
      description:
        "Course completion logic awards Dean's List only when stories are completed; lesson-only courses have zero stories so the credential is unreachable.",
      expected: "Completing all lessons in a lesson-only course awards Dean's List.",
      actual: 'Completing all lessons leaves the credential locked.',
      repro:
        "1. Finish every lesson in a lesson-only course. 2. Open Profile → Credentials. Dean's List is missing.",
    });
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([finding])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(0);
  });

  it('skips a finding that matches a DISMISSED preview (user already said "not a bug")', async () => {
    insertPreview({
      repoId,
      runId,
      agentName: 'qa-hunter',
      payload: {
        kind: 'issue',
        title: '[bug] Reset progress leaves streak state behind',
        body: 'body',
        labels: ['obelisk:fix', 'P1'],
      },
    });
    // Dismiss the preview we just inserted. listAllPreviewTitlesForRepo
    // should still surface its title for dedup.
    const dismissedRowId = listPreviewsForRepo(repoId, 200)[0]!.id;
    markPreviewDismissed({ sourcePreviewId: dismissedRowId, runId });

    // Sanity: this dismissed-preview title is NOT in the open list…
    expect(listOpenPreviewTitlesForRepo(repoId)).not.toContain(
      '[bug] Reset progress leaves streak state behind',
    );
    // …but IS in the all-titles dedup list.
    expect(listAllPreviewTitlesForRepo(repoId)).toContain(
      '[bug] Reset progress leaves streak state behind',
    );

    const stdout = `BEGIN_FINDINGS
${JSON.stringify([findingFixture({})])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(0);
  });

  it('renders a rich body with Description / Expected / Actual / Steps / Evidence sections', async () => {
    const finding = findingFixture({
      title: 'Coverage map drops cases for archived plans',
    });
    const stdout = `BEGIN_FINDINGS
${JSON.stringify([finding])}
END_FINDINGS`;
    const out = await qaHunterHandler.interpretResult(fakeInput(stdout));
    expect(out).toHaveLength(1);
    const body = (out[0] as { body: string }).body;
    expect(body).toContain('## Description');
    expect(body).toContain('## Expected behavior');
    expect(body).toContain('## Actual behavior');
    expect(body).toContain('## Steps to reproduce');
    expect(body).toContain('## Evidence');
    expect(body).toContain('## Suspected files');
    expect(body).toContain('## Suggested test');
    expect(body).toContain('## Severity');
    expect(body).toContain('AppState.reset()');
  });
});
