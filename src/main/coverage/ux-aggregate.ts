import { getRepo } from '../db/repos';
import { listRuns } from '../db/runs';
import { listPlans, getPlan } from '../test-plans/store';
import { listPreviewsForRepo } from '../db/previews';
import { OBELISK_LABELS } from '../publisher/labels';
import { ObeliskError } from '../../shared/errors';
import { loadCoverageMap, matchesAnyGlob, resolveScopeToGlobs } from './coverage-map';
import { parseSuspectedFiles } from './aggregate';
import { parsePlanHint } from '../test-plans/inject';
import type {
  TestPlan,
  TestPlanRef,
  UxCoverageReport,
  UxHealth,
  UxSurface,
} from '../../shared/types';

/**
 * Build the UX/UI coverage report for a repo — the read-out behind the
 * Coverage screen's "UX Coverage" tab.
 *
 * This is intentionally NOT the proof-based test-coverage formula. UX coverage
 * answers a different question: *which surfaces has the UI/UX Expert swept, and
 * which carry open UX debt?* So instead of "cases passed", it tracks:
 *   - lastSweptAt: the newest DONE `ux-expert` run touching the surface — either
 *     a run on a feature-scoped UX plan, or a whole-app UX sweep (which visits
 *     every surface, so it advances all of them).
 *   - openFindings: open `ux`-labeled previews whose suspected files fall in the
 *     surface's globs, broken down by severity.
 *
 * The surface taxonomy is the SHARED, agent-agnostic `qa/coverage-map.md`, so a
 * UX sweep and a QA sweep speak the same feature vocabulary. Read-only.
 */
export async function buildUxCoverageReport(repoId: string): Promise<UxCoverageReport> {
  const repo = getRepo(repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${repoId} not found`);

  const coverageMap = loadCoverageMap(repo.localPath);

  // Load all plans so we can find the ones the UI/UX Expert can run.
  const planSummaries = listPlans(repo.localPath);
  const plans: TestPlan[] = [];
  for (const summary of planSummaries) {
    try {
      plans.push(getPlan(repo.localPath, summary.id));
    } catch {
      // Skip plans that fail to parse — they don't contribute coverage.
    }
  }

  const isUxPlan = (p: TestPlan): boolean => p.frontmatter.agentNames.includes('ux-expert');

  // Feature-scoped UX plans, indexed by label; and whole-app UX plans.
  const uxPlanRefsByLabel = new Map<string, TestPlanRef[]>();
  const wholeAppUxPlanIds = new Set<string>();
  const wholeAppPlans: TestPlanRef[] = [];
  // Reverse index: planId → the feature label it's scoped to (UX plans only).
  const featureLabelByPlanId = new Map<string, string>();

  for (const p of plans) {
    if (!isUxPlan(p)) continue;
    const ref: TestPlanRef = {
      id: p.frontmatter.id,
      name: p.frontmatter.name,
      agentNames: p.frontmatter.agentNames,
      updatedAt: p.updatedAt,
    };
    if (p.frontmatter.scope === 'feature' && p.frontmatter.feature) {
      const label = p.frontmatter.feature.toLowerCase();
      const list = uxPlanRefsByLabel.get(label) ?? [];
      list.push(ref);
      uxPlanRefsByLabel.set(label, list);
      featureLabelByPlanId.set(p.frontmatter.id, label);
    } else if (p.frontmatter.scope === 'whole-app') {
      wholeAppUxPlanIds.add(p.frontmatter.id);
      wholeAppPlans.push(ref);
    }
  }

  // lastSweptAt: walk done ux-expert runs. A feature-scoped run advances its
  // own surface; a whole-app run advances ALL surfaces (it visits everything).
  const lastSweptByLabel = new Map<string, string>();
  let wholeAppLastSweptAt: string | null = null;
  let lastSweptAt: string | null = null;
  for (const run of listRuns(repoId, 200)) {
    if (run.agentName !== 'ux-expert') continue;
    if (run.state !== 'done' || !run.finishedAt) continue;
    if (lastSweptAt === null || run.finishedAt > lastSweptAt) lastSweptAt = run.finishedAt;

    const planId = parsePlanHint(run.taskRef ?? undefined);
    if (!planId) continue;
    if (wholeAppUxPlanIds.has(planId)) {
      if (wholeAppLastSweptAt === null || run.finishedAt > wholeAppLastSweptAt) {
        wholeAppLastSweptAt = run.finishedAt;
      }
      continue;
    }
    const label = featureLabelByPlanId.get(planId);
    if (!label) continue;
    const cur = lastSweptByLabel.get(label);
    if (!cur || run.finishedAt > cur) lastSweptByLabel.set(label, run.finishedAt);
  }

  // Open `ux`-labeled previews → suspected files + severity, for per-surface
  // attribution. Mirrors the open-findings loop in aggregate.ts.
  interface UxPreview {
    suspected: string[];
    severity: 'P0' | 'P1' | 'P2';
  }
  const uxPreviews: UxPreview[] = [];
  for (const p of listPreviewsForRepo(repoId, 500)) {
    if (p.dismissed || p.published) continue;
    if (!p.labels.includes(OBELISK_LABELS.ux)) continue;
    uxPreviews.push({
      suspected: parseSuspectedFiles(p.body),
      // The UI/UX Expert emits a bare `P0`/`P1`/`P2` label (qa-hunter
      // convention); the preview row's `severity` only parses the
      // `severity:Px` form, so read it off the labels directly.
      severity: severityFromLabels(p.labels) ?? p.severity ?? 'P2',
    });
  }

  // Build one surface per coverage-map label.
  const surfaces: UxSurface[] = [];
  for (const label of coverageMap.keys()) {
    const globs = resolveScopeToGlobs([label], coverageMap);

    const bySeverity = { P0: 0, P1: 0, P2: 0 };
    let openFindings = 0;
    for (const pv of uxPreviews) {
      if (pv.suspected.some((path) => matchesAnyGlob(path, globs))) {
        openFindings += 1;
        bySeverity[pv.severity] += 1;
      }
    }

    // The surface is swept by its own feature run OR by any whole-app sweep.
    const featureSwept = lastSweptByLabel.get(label) ?? null;
    const sweptAt = maxIso(featureSwept, wholeAppLastSweptAt);
    const swept = sweptAt !== null;

    const planRefs = (uxPlanRefsByLabel.get(label) ?? [])
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    surfaces.push({
      label,
      planCount: planRefs.length,
      lastSweptAt: sweptAt,
      swept,
      openFindings,
      bySeverity,
      uxHealth: deriveUxHealth(swept, openFindings),
      coverageScore: uxScore(swept, bySeverity),
      planRefs,
    });
  }

  // Sort: unswept first (the gaps), then most open findings, then alphabetical.
  surfaces.sort((a, b) => {
    if (a.swept !== b.swept) return a.swept ? 1 : -1;
    if (a.openFindings !== b.openFindings) return b.openFindings - a.openFindings;
    return a.label.localeCompare(b.label);
  });

  return {
    repoId,
    hasCoverageMap: coverageMap.size > 0,
    surfaces,
    wholeAppPlans: wholeAppPlans.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    totalSurfaces: surfaces.length,
    sweptSurfaces: surfaces.filter((s) => s.swept).length,
    lastSweptAt,
  };
}

function severityFromLabels(labels: string[]): 'P0' | 'P1' | 'P2' | null {
  for (const l of labels) {
    if (l === 'P0' || l === 'P1' || l === 'P2') return l;
    const m = /^severity:(P[012])$/.exec(l);
    if (m) return m[1] as 'P0' | 'P1' | 'P2';
  }
  return null;
}

function deriveUxHealth(swept: boolean, openFindings: number): UxHealth {
  if (!swept) return 'unswept';
  return openFindings > 0 ? 'attention' : 'healthy';
}

/**
 * 0–100 UX score for the radar axis. Unswept surfaces score 0 (the axis is
 * pulled to the center — clearly "no coverage"). A swept surface starts at 100
 * and is dragged inward by its open UX debt, weighted by severity, but floored
 * at 30 so it still reads as "audited, needs work" rather than collapsing onto
 * an unswept surface.
 */
function uxScore(swept: boolean, bySeverity: { P0: number; P1: number; P2: number }): number {
  if (!swept) return 0;
  const penalty = bySeverity.P0 * 40 + bySeverity.P1 * 20 + bySeverity.P2 * 8;
  if (penalty === 0) return 100;
  return Math.max(30, 100 - penalty);
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
