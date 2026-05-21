import { simpleGit } from 'simple-git';
import { getDb } from '../db';
import { getRepo } from '../db/repos';
import { listRuns } from '../db/runs';
import { listPlans, getPlan } from '../test-plans/store';
import { listPreviewsForRepo } from '../db/previews';
import { ObeliskError } from '../../shared/errors';
import { loadCoverageMap, matchesAnyGlob, resolveScopeToGlobs } from './coverage-map';
import type { CoverageMap } from './coverage-map';
import { scanFromTrackedFiles } from './feature-scan';
import { derivePerCaseState } from '../../shared/case-progress';
import { computeFeatureScore } from '../../shared/coverage-formula';
import type {
  AgentName,
  AuditLine,
  CoverageEntry,
  CoverageFeature,
  CoverageReport,
  TestPlan,
  TestPlanRef,
} from '../../shared/types';

/** Files-per-feature cap on the IPC payload — keeps responses bounded for large globs. */
const MAX_FILES_PER_FEATURE = 500;
/** "Recent pass" cutoff for the freshness score, in days. */
const FRESHNESS_WINDOW_DAYS = 14;

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
  const plansById = new Map(plans.map((p) => [p.frontmatter.id, p] as const));

  // 1) caseCount per file + per-feature index.
  const caseCount = new Map<string, number>();
  // For each plan, collect the set of files that ANY of its cases target —
  // used in the lastPassedAt step below.
  const planFiles = new Map<string, Set<string>>();

  interface FeatureScratch {
    planRefs: Map<string, { id: string; name: string; agentNames: AgentName[]; updatedAt: string }>;
    caseIds: Set<string>;
    /** caseIds tagged with this feature, grouped by their owning plan. */
    caseIdsByPlan: Map<string, Set<string>>;
  }
  const featureScratch = new Map<string, FeatureScratch>();
  // Plans with frontmatter.scope === 'whole-app' surface in their own
  // "Whole-app QA" row rather than on per-feature cards. We collect them
  // here so the IPC payload carries them without a second walk over `plans`.
  const wholeAppPlans = new Map<string, TestPlanRef>();

  function scratchFor(label: string): FeatureScratch {
    let s = featureScratch.get(label);
    if (!s) {
      s = { planRefs: new Map(), caseIds: new Set(), caseIdsByPlan: new Map() };
      featureScratch.set(label, s);
    }
    return s;
  }

  // Seed features from THREE sources so the radar reflects the whole app,
  // not just whatever a plan happens to mention:
  //   (a) live filesystem scan — every feature directory the repo has,
  //       even if no plan / map entry exists yet
  //   (b) coverage-map.md labels — user-curated names and globs
  //   (c) plan scope tags — handled by the loop below
  //
  // Each seeded label gets the best-available globs: map-entry wins, else
  // the scanner's auto-derived globs, else the substring fallback baked
  // into `resolveScopeToGlobs`.
  const scanned = scanFromTrackedFiles(repo.localPath, trackedFiles);
  const scannerGlobs = new Map<string, string[]>();
  for (const c of scanned) {
    scannerGlobs.set(c.label, c.globs);
    scratchFor(c.label);
  }
  for (const label of coverageMap.keys()) {
    scratchFor(label);
  }

  for (const plan of plans) {
    const filesForPlan = new Set<string>();
    // A plan attaches to a feature card ONLY when it's explicitly scoped to
    // that feature (frontmatter.scope === 'feature' + matching `feature`).
    // Whole-app plans live in their own bucket and surface in a dedicated
    // "Whole-app QA" row — they no longer leak onto feature cards via
    // per-case scope tags, which was the source of the confusing
    // "4 plans cover this feature" footer.
    const planFeatureLabel =
      plan.frontmatter.scope === 'feature' && plan.frontmatter.feature
        ? plan.frontmatter.feature.toLowerCase()
        : null;
    if (planFeatureLabel) {
      const s = scratchFor(planFeatureLabel);
      s.planRefs.set(plan.frontmatter.id, {
        id: plan.frontmatter.id,
        name: plan.frontmatter.name,
        agentNames: plan.frontmatter.agentNames,
        updatedAt: plan.updatedAt,
      });
    } else if (plan.frontmatter.scope === 'whole-app') {
      wholeAppPlans.set(plan.frontmatter.id, {
        id: plan.frontmatter.id,
        name: plan.frontmatter.name,
        agentNames: plan.frontmatter.agentNames,
        updatedAt: plan.updatedAt,
      });
    }
    for (const block of plan.blocks) {
      if (block.kind !== 'case') continue;
      const scope = block.scope ?? [];
      // Even if a case has no explicit scope, count it toward the plan's
      // owning feature so the planRefs / caseCount aren't empty.
      const effectiveLabels = scope.length > 0 ? scope : planFeatureLabel ? [planFeatureLabel] : [];
      if (effectiveLabels.length === 0) continue;
      for (const label of effectiveLabels) {
        const lower = label.toLowerCase();
        const s = scratchFor(lower);
        s.caseIds.add(block.id);
        let byPlan = s.caseIdsByPlan.get(plan.frontmatter.id);
        if (!byPlan) {
          byPlan = new Set();
          s.caseIdsByPlan.set(plan.frontmatter.id, byPlan);
        }
        byPlan.add(block.id);
      }
      const globs = resolveScopeToGlobs(effectiveLabels, coverageMap);
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
  //    run's plan. Also remember the latest done run per plan — used in
  //    step 5 to compute per-feature casesPassed.
  const lastPassedAt = new Map<string, string>();
  const latestDoneRunByPlan = new Map<string, { runId: string; finishedAt: string }>();
  let lastDoneAt: string | null = null;
  const runs = listRuns(repoId, 200);
  for (const run of runs) {
    if (run.state !== 'done') continue;
    if (!run.finishedAt) continue;
    if (lastDoneAt === null || run.finishedAt > lastDoneAt) lastDoneAt = run.finishedAt;
    const planId = parsePlanIdFromTaskRef(run.taskRef);
    if (!planId) continue;
    const files = planFiles.get(planId);
    if (files) {
      for (const file of files) {
        const cur = lastPassedAt.get(file);
        if (!cur || run.finishedAt > cur) lastPassedAt.set(file, run.finishedAt);
      }
    }
    const prev = latestDoneRunByPlan.get(planId);
    if (!prev || run.finishedAt > prev.finishedAt) {
      latestDoneRunByPlan.set(planId, { runId: run.id, finishedAt: run.finishedAt });
    }
  }

  // 3) findingsCount per file: walk open previews, parse the `Suspected files`
  //    block out of the markdown body. Best-effort — bodies that don't follow
  //    the convention contribute zero. We also keep the raw set of suspected
  //    files per preview around so step 6 can attribute findings to features.
  const findingsCount = new Map<string, number>();
  const previews = listPreviewsForRepo(repoId, 500);
  const openPreviewSuspectedFiles: string[][] = [];
  for (const p of previews) {
    if (p.dismissed || p.published) continue;
    const suspected = parseSuspectedFiles(p.body);
    openPreviewSuspectedFiles.push(suspected);
    for (const file of suspected) {
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

  // 5) Per-plan: pull case_progress audit rows for the latest done run and
  //    project them into a per-case state map (passed/failed/skipped/…).
  //    Used by step 6 below to count `casesPassed` per feature.
  const passedCaseIdsByPlan = new Map<string, Set<string>>();
  for (const [planId, runRef] of latestDoneRunByPlan) {
    const plan = plansById.get(planId);
    if (!plan) continue;
    const auditLog = loadAuditLog(runRef.runId);
    const { byCase } = derivePerCaseState({
      plan,
      auditLog,
      findings: [],
      runState: 'done',
    });
    const passed = new Set<string>();
    for (const [caseId, state] of byCase) {
      if (state === 'passed') passed.add(caseId);
    }
    passedCaseIdsByPlan.set(planId, passed);
  }

  // 6) Per-feature aggregation. Walk the scratch map, resolve each label's
  //    glob, intersect with the per-file aggregates from steps 1–4, compute
  //    the composite coveragePct, and collect plan refs for the run CTAs.
  const freshnessCutoffIso = new Date(
    Date.now() - FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const fileByPath = new Map(fileEntries.map((e) => [e.path, e] as const));
  const features: CoverageFeature[] = [];
  const staleLabels: string[] = [];

  for (const [label, scratch] of featureScratch) {
    // Map entry wins. If the label isn't in the map, fall back to the
    // scanner's auto-derived globs. If neither knows about it (a scope
    // tag on a case for which we have no glob anywhere), resolveScope
    // falls through to substring matching.
    let globs: string[];
    if (coverageMap.has(label)) {
      globs = resolveScopeToGlobs([label], coverageMap);
    } else if (scannerGlobs.has(label)) {
      globs = scannerGlobs.get(label)!;
    } else {
      globs = resolveScopeToGlobs([label], coverageMap);
    }
    const filesInGlob: string[] = [];
    for (const file of trackedFiles) {
      if (matchesAnyGlob(file, globs)) filesInGlob.push(file);
    }
    // 0-file labels aren't features — they're broken globs the user needs
    // to fix. Showing them as feature cards (with "Run QA Hunter" buttons
    // that target zero files) is misleading. Relegate to staleLabels;
    // the Coverage screen surfaces them as a separate diagnostic strip
    // with a "fix in qa/coverage-map.md" CTA. EXCEPTION: a label with a
    // bound plan still appears so the user can see the binding even when
    // the globs are wrong — they can fix the glob from there.
    if (filesInGlob.length === 0 && scratch.planRefs.size === 0) {
      // Only labels actually present in qa/coverage-map.md are reportable
      // as stale — the cleanup CTA can only edit lines that exist in that
      // file. Scratch entries seeded purely by per-case `scope` tags
      // (e.g. a whole-app plan tagging cases with "smoke") would otherwise
      // show up as broken labels the user can't remove.
      if (coverageMap.has(label)) {
        staleLabels.push(label);
      }
      continue;
    }

    let filesWithCases = 0;
    let filesRecentPass = 0;
    for (const file of filesInGlob) {
      const entry = fileByPath.get(file);
      if (!entry) continue;
      if (entry.caseCount > 0) filesWithCases += 1;
      if (
        entry.lastPassedAt &&
        entry.lastPassedAt >= freshnessCutoffIso &&
        entry.churnSinceLastPass === 0
      ) {
        filesRecentPass += 1;
      }
    }

    let openFindings = 0;
    for (const suspected of openPreviewSuspectedFiles) {
      if (suspected.some((p) => matchesAnyGlob(p, globs))) openFindings += 1;
    }

    let casesPassed = 0;
    for (const [planId, caseIdsForLabel] of scratch.caseIdsByPlan) {
      const passed = passedCaseIdsByPlan.get(planId);
      if (!passed) continue;
      for (const caseId of caseIdsForLabel) {
        if (passed.has(caseId)) casesPassed += 1;
      }
    }

    const caseCountForLabel = scratch.caseIds.size;
    const score = computeFeatureScore({
      filesInGlob: filesInGlob.length,
      filesWithCases,
      filesRecentPass,
      caseCount: caseCountForLabel,
      casesPassed,
      openFindings,
    });

    const planRefs = Array.from(scratch.planRefs.values())
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((p) => ({
        id: p.id,
        name: p.name,
        agentNames: p.agentNames,
        updatedAt: p.updatedAt,
      }));

    features.push({
      label,
      planCount: scratch.planRefs.size,
      caseCount: caseCountForLabel,
      casesPassed,
      filesInGlob: filesInGlob.length,
      filesWithCases,
      filesRecentPass,
      openFindings,
      coveragePct: score.coveragePct,
      planRefs,
      files: filesInGlob.slice(0, MAX_FILES_PER_FEATURE),
    });
  }

  // Sort: lowest coverage first (most attention needed). Within same %,
  // features with more cases beat features with fewer (touching anything
  // is signal that the user cares about it).
  features.sort((a, b) => {
    if (a.coveragePct !== b.coveragePct) return a.coveragePct - b.coveragePct;
    return b.caseCount - a.caseCount;
  });
  staleLabels.sort();

  let coveredFiles = 0;
  let uncoveredFiles = 0;
  for (const f of fileEntries) {
    if (f.caseCount > 0) coveredFiles++;
    else uncoveredFiles++;
  }

  const wholeAppPlansSorted = Array.from(wholeAppPlans.values()).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );

  return {
    repoId,
    files: fileEntries,
    features,
    wholeAppPlans: wholeAppPlansSorted,
    staleLabels,
    hasCoverageMap: coverageMap.size > 0,
    totalFiles: fileEntries.length,
    coveredFiles,
    uncoveredFiles,
    lastDoneAt,
  };
}

function loadAuditLog(runId: string): AuditLine[] {
  const rows = getDb()
    .prepare<
      [string],
      { id: number; run_id: string; at: string; kind: string; payload: string }
    >('SELECT * FROM audit_log WHERE run_id = ? ORDER BY id ASC')
    .all(runId);
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    at: r.at,
    kind: r.kind,
    payload: safeParse(r.payload),
  }));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
