import { simpleGit } from 'simple-git';
import { getRepo } from '../db/repos';
import { listRuns } from '../db/runs';
import { listPlans, getPlan } from '../test-plans/store';
import { listPreviewsForRepo } from '../db/previews';
import { ObeliskError } from '../../shared/errors';
import { loadCoverageMap, matchesAnyGlob, resolveScopeToGlobs } from './coverage-map';
import type { CoverageMap } from './coverage-map';
import type { CoverageEntry, CoverageReport, TestPlan } from '../../shared/types';

/**
 * Build a per-file coverage report for a repo. Read-only — the function
 * walks plan files, queries the run/preview audit logs, and runs a single
 * `git log --name-only` to compute churn.
 */
export async function buildCoverageReport(repoId: string): Promise<CoverageReport> {
  const repo = getRepo(repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${repoId} not found`);

  const git = simpleGit(repo.localPath);
  const trackedFiles = await listTrackedFiles(git);
  const coverageMap = loadCoverageMap(repo.localPath);

  // Load all plans so we can intersect case scopes with file globs.
  const planSummaries = listPlans(repo.localPath);
  const plans: TestPlan[] = [];
  for (const summary of planSummaries) {
    try {
      plans.push(getPlan(repo.localPath, summary.id));
    } catch {
      // Skip plans that fail to parse — they don't contribute coverage.
    }
  }

  // 1) caseCount per file + per-label index.
  const caseCount = new Map<string, number>();
  const labelStats = new Map<string, { planIds: Set<string>; caseCount: number }>();
  // For each plan, collect the set of files that ANY of its cases target —
  // used in the lastPassedAt step below.
  const planFiles = new Map<string, Set<string>>();
  for (const plan of plans) {
    const filesForPlan = new Set<string>();
    for (const block of plan.blocks) {
      if (block.kind !== 'case') continue;
      const scope = block.scope ?? [];
      if (scope.length === 0) continue;
      for (const label of scope) {
        const lower = label.toLowerCase();
        const stats = labelStats.get(lower) ?? { planIds: new Set(), caseCount: 0 };
        stats.planIds.add(plan.frontmatter.id);
        stats.caseCount += 1;
        labelStats.set(lower, stats);
      }
      const globs = resolveScopeToGlobs(scope, coverageMap);
      for (const file of trackedFiles) {
        if (matchesAnyGlob(file, globs)) {
          caseCount.set(file, (caseCount.get(file) ?? 0) + 1);
          filesForPlan.add(file);
        }
      }
    }
    planFiles.set(plan.frontmatter.id, filesForPlan);
  }

  // 2) lastPassedAt per file: walk done runs, attribute to all files in the
  //    run's plan.
  const lastPassedAt = new Map<string, string>();
  let lastDoneAt: string | null = null;
  const runs = listRuns(repoId, 200);
  for (const run of runs) {
    if (run.state !== 'done') continue;
    if (!run.finishedAt) continue;
    if (lastDoneAt === null || run.finishedAt > lastDoneAt) lastDoneAt = run.finishedAt;
    const planId = parsePlanIdFromTaskRef(run.taskRef);
    if (!planId) continue;
    const files = planFiles.get(planId);
    if (!files) continue;
    for (const file of files) {
      const cur = lastPassedAt.get(file);
      if (!cur || run.finishedAt > cur) lastPassedAt.set(file, run.finishedAt);
    }
  }

  // 3) findingsCount per file: walk open previews, parse the `Suspected files`
  //    block out of the markdown body. Best-effort — bodies that don't follow
  //    the convention contribute zero.
  const findingsCount = new Map<string, number>();
  const previews = listPreviewsForRepo(repoId, 500);
  for (const p of previews) {
    if (p.dismissed || p.published) continue;
    for (const file of parseSuspectedFiles(p.body)) {
      findingsCount.set(file, (findingsCount.get(file) ?? 0) + 1);
    }
  }

  // 4) Git churn since lastPassedAt — one global `git log --name-only` since
  //    the oldest lastPassedAt across the repo, then filter per-file. Cheaper
  //    than per-file log invocations and good enough at our scale.
  const churn = await computeChurn(git, lastPassedAt);

  const fileEntries: CoverageEntry[] = trackedFiles.map((path) => ({
    path,
    caseCount: caseCount.get(path) ?? 0,
    findingsCount: findingsCount.get(path) ?? 0,
    lastPassedAt: lastPassedAt.get(path) ?? null,
    churnSinceLastPass: churn.get(path) ?? 0,
  }));

  // Sort: most-needs-attention first (finding-bearing → uncovered with churn → covered with churn → covered).
  fileEntries.sort((a, b) => {
    const score = (e: CoverageEntry): number =>
      e.findingsCount * 1000 +
      (e.caseCount === 0 && e.churnSinceLastPass > 0 ? 500 : 0) +
      e.churnSinceLastPass * 10 -
      e.caseCount;
    return score(b) - score(a);
  });

  const labels = Array.from(labelStats.entries())
    .map(([label, stats]) => ({
      label,
      planCount: stats.planIds.size,
      caseCount: stats.caseCount,
    }))
    .sort((a, b) => b.caseCount - a.caseCount);

  let coveredFiles = 0;
  let uncoveredFiles = 0;
  for (const f of fileEntries) {
    if (f.caseCount > 0) coveredFiles++;
    else uncoveredFiles++;
  }

  return {
    repoId,
    files: fileEntries,
    labels,
    totalFiles: fileEntries.length,
    coveredFiles,
    uncoveredFiles,
    lastDoneAt,
  };
}

async function listTrackedFiles(git: ReturnType<typeof simpleGit>): Promise<string[]> {
  try {
    const out = await git.raw(['ls-files']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(
        (p) => !p.startsWith('node_modules/') && !p.startsWith('out/') && !p.startsWith('dist/'),
      );
  } catch {
    return [];
  }
}

async function computeChurn(
  git: ReturnType<typeof simpleGit>,
  lastPassedAt: Map<string, string>,
): Promise<Map<string, number>> {
  const churn = new Map<string, number>();
  if (lastPassedAt.size === 0) return churn;
  // Use the oldest lastPassedAt across all files as the `--since` filter,
  // then walk the log once. Files passed more recently get filtered as we
  // attribute commits.
  const oldest = Array.from(lastPassedAt.values()).sort()[0];
  if (!oldest) return churn;

  let log: string;
  try {
    log = await git.raw([
      'log',
      `--since=${oldest}`,
      '--name-only',
      '--pretty=format:COMMIT %H %cI',
    ]);
  } catch {
    return churn;
  }
  let currentCommitTime: string | null = null;
  for (const rawLine of log.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^COMMIT\s+\S+\s+(\S+)$/.exec(line);
    if (m) {
      currentCommitTime = m[1] ?? null;
      continue;
    }
    if (!currentCommitTime) continue;
    // Only count commits AFTER this file's lastPassedAt.
    const passed = lastPassedAt.get(line);
    if (passed && currentCommitTime <= passed) continue;
    churn.set(line, (churn.get(line) ?? 0) + 1);
  }
  return churn;
}

function parsePlanIdFromTaskRef(taskRef: string | null): string | null {
  if (!taskRef) return null;
  return taskRef.startsWith('plan:') ? taskRef.slice('plan:'.length) : null;
}

/**
 * Pull the file list out of a finding's markdown body. Looks for the
 * `## Suspected files` header (qa-hunter's convention) and reads back-tick-
 * quoted paths from the bullet list immediately below it.
 */
export function parseSuspectedFiles(body: string): string[] {
  const idx = body.search(/^##\s+Suspected files\s*$/im);
  if (idx < 0) return [];
  const tail = body.slice(idx);
  const out: string[] = [];
  for (const rawLine of tail.split('\n').slice(1)) {
    const line = rawLine.trim();
    if (line.startsWith('## ')) break; // next section
    const m = /^[-*]\s+`([^`]+)`/.exec(line);
    if (m) {
      const path = m[1]!.trim().replace(/:\d+$/, ''); // strip line numbers
      if (path) out.push(path);
    }
  }
  return out;
}

/**
 * Pick the top-N files that the next QA plan should skew toward — the
 * "what's dark and what's drifted" list. Used by `testPlans:generate` when
 * the user toggles the Focus checkbox in the New plan dialog. Cap is ~30 so
 * the prompt stays bounded.
 *
 * Selection rules (highest priority first):
 *   1. Files with open findings (caseCount might be > 0, but they've been
 *      flagged — re-check them).
 *   2. Uncovered files with churn since last pass (new code that no plan
 *      touches).
 *   3. Files with churn since last pass (covered but drifted).
 *   4. Uncovered files (cold, no churn).
 *
 * Stable sort within each tier so the returned list reads top-down by
 * desirability. Excludes never-passed-and-no-churn covered files — those
 * aren't actionable for "what to test next."
 */
export interface FocusFile {
  path: string;
  caseCount: number;
  churnSinceLastPass: number;
  findingsCount: number;
  reason: 'open-findings' | 'uncovered-with-churn' | 'churn-since-pass' | 'uncovered';
}

export function pickFocusFiles(report: CoverageReport, limit = 30): FocusFile[] {
  const out: FocusFile[] = [];
  for (const f of report.files) {
    let reason: FocusFile['reason'] | null = null;
    if (f.findingsCount > 0) reason = 'open-findings';
    else if (f.caseCount === 0 && f.churnSinceLastPass > 0) reason = 'uncovered-with-churn';
    else if (f.churnSinceLastPass > 0) reason = 'churn-since-pass';
    else if (f.caseCount === 0) reason = 'uncovered';
    if (!reason) continue;
    out.push({
      path: f.path,
      caseCount: f.caseCount,
      churnSinceLastPass: f.churnSinceLastPass,
      findingsCount: f.findingsCount,
      reason,
    });
  }
  const tierRank: Record<FocusFile['reason'], number> = {
    'open-findings': 0,
    'uncovered-with-churn': 1,
    'churn-since-pass': 2,
    uncovered: 3,
  };
  out.sort((a, b) => {
    const t = tierRank[a.reason] - tierRank[b.reason];
    if (t !== 0) return t;
    // Within a tier: more attention-needed first.
    const score = (e: FocusFile): number =>
      e.findingsCount * 1000 + e.churnSinceLastPass * 10 - e.caseCount;
    return score(b) - score(a);
  });
  return out.slice(0, limit);
}

// Re-export the CoverageMap type for callers that want to mock the loader in tests.
export type { CoverageMap };
// Re-export the report types for ergonomics.
export type { CoverageEntry, CoverageReport };
