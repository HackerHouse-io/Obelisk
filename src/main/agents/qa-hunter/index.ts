import { getGithub } from '../../github/client';
import { OBELISK_LABELS } from '../../publisher/labels';
import { parseFencedJson } from '../lib/parse-fenced-json';
import { previewTitleConflicts } from '../lib/find-existing-issue';
import { listOpenPreviewTitlesForRepo } from '../../db/previews';
import { resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const qaHunterHandler: AgentHandler = {
  name: 'qa-hunter',
  // Multi-instance: each instance pairs with a test plan, so multiple
  // instances let you run different plans (full-app sweep, checkout flow,
  // onboarding) on different schedules in parallel. Per-plan single-flight
  // (enforced in createRun by task_ref) prevents two runs of the SAME plan
  // from racing.
  multiInstance: true,
  addAnotherExplainer:
    'Adds another QA Hunter instance — pair it with a different test plan and schedule.',
  // QA Hunter doesn't write code; it files issues. The Evidence Pack gate
  // (which is about PR evidence) doesn't apply.
  skipsEvidenceGate: true,
  producesPatch: false,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // QA Hunter must run against a test plan — the gate is enforced by
    // resolvePlanForAgentRun, which throws TEST_PLAN_REQUIRED if none exists.
    const plan = resolvePlanForAgentRun(input.repo, 'qa-hunter', input.taskId);
    const assigned = toAssignedPlan(plan);
    const ts = new Date().toISOString();
    return {
      task: {
        ref: `plan:${plan.frontmatter.id}`,
        kind: 'sweep',
        context: `Run ${plan.frontmatter.name} against ${input.repo.githubFullName}. Execute every test case in the assigned plan and emit findings as JSON.\n\nGenerated at ${ts}.`,
        assignedPlan: assigned,
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const findings = parseFindings(input.runResult.reasoning);
    if (findings.length === 0) return [];

    // Two dedup passes:
    //   1. Open previews for this repo (the recurring-sweep gotcha — without
    //      this, a daily QA Hunter run would pile a fresh preview onto an
    //      already-pending one).
    //   2. Open GitHub issues with the obelisk:fix label (covers Issues mode
    //      where findings get published, plus older runs whose previews were
    //      filed manually).
    const openPreviewTitles = listOpenPreviewTitlesForRepo(input.repo.id);
    const out: PublishPlan[] = [];
    for (const f of findings) {
      const title = titleFor(f);
      if (openPreviewTitles.some((t) => previewTitleConflicts(t, title))) continue;
      const dup = await findDuplicateIssue(input.repo.githubFullName, title).catch(() => null);
      if (dup !== null) continue;
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f),
        labels: labelsFor(f),
      });
      // Track this title as "filed" within the same run so two findings in
      // ONE batch with similar titles also dedup against each other.
      openPreviewTitles.push(title);
    }
    return out;
  },
};

/* ---------- output parsing ---------- */

interface Finding {
  title: string;
  severity: 'P0' | 'P1' | 'P2';
  description: string;
  expected: string;
  actual: string;
  repro: string;
  evidence?: string;
  suspected_files: string[];
  suggested_test: string;
  suspected_kind?: 'bug' | 'coverage';
}

export function parseFindings(stdout: string): Finding[] {
  return parseFencedJson<Finding>(stdout, 'BEGIN_FINDINGS', 'END_FINDINGS', isFinding);
}

function isFinding(v: unknown): v is Finding {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['title'] === 'string' &&
    (obj['severity'] === 'P0' || obj['severity'] === 'P1' || obj['severity'] === 'P2') &&
    typeof obj['description'] === 'string' &&
    obj['description'].trim().length > 0 &&
    typeof obj['expected'] === 'string' &&
    obj['expected'].trim().length > 0 &&
    typeof obj['actual'] === 'string' &&
    obj['actual'].trim().length > 0 &&
    typeof obj['repro'] === 'string' &&
    obj['repro'].trim().length > 0 &&
    Array.isArray(obj['suspected_files']) &&
    obj['suspected_files'].every((f) => typeof f === 'string') &&
    typeof obj['suggested_test'] === 'string' &&
    (obj['evidence'] === undefined || typeof obj['evidence'] === 'string')
  );
}

function titleFor(f: Finding): string {
  const prefix = f.severity === 'P2' ? '[smell]' : '[bug]';
  return `${prefix} ${f.title}`;
}

function bodyFor(f: Finding): string {
  const sections: string[] = [
    `## Description`,
    f.description.trim(),
    '',
    `## Expected behavior`,
    f.expected.trim(),
    '',
    `## Actual behavior`,
    f.actual.trim(),
    '',
    `## Steps to reproduce`,
    f.repro.trim(),
    '',
    `## Evidence`,
    f.evidence && f.evidence.trim().length > 0 ? f.evidence.trim() : '_(no evidence captured)_',
    '',
    `## Suspected files`,
    f.suspected_files.length === 0
      ? '_(none identified)_'
      : f.suspected_files.map((p) => `- \`${p}\``).join('\n'),
    '',
    `## Suggested test`,
    `\`\`\`\n${f.suggested_test}\n\`\`\``,
    '',
    `## Severity`,
    f.severity,
    '',
    `> Filed by Obelisk QA Hunter. Reply \`/obelisk fix\` to assign Bug Fixer to this issue.`,
  ];
  return sections.join('\n');
}

function labelsFor(f: Finding): string[] {
  return [OBELISK_LABELS.fix, f.severity];
}

/**
 * Dedup helper: returns true if a fuzzy-matching obelisk-filed issue already
 * exists. Caller should drop the finding before publishing.
 *
 * Phase 5 uses simple substring matching on the title; Phase 11+ adds
 * fuzzy similarity (Levenshtein ≥ 0.85) per AGENT_ARCHITECTURE.md §4.1.
 */
export async function findDuplicateIssue(
  repoFullName: string,
  candidateTitle: string,
): Promise<number | null> {
  const gh = await getGithub();
  if (!gh) return null;
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) return null;
  const { data } = await gh.issues.listForRepo({
    owner,
    repo: name,
    labels: OBELISK_LABELS.fix,
    state: 'open',
    per_page: 100,
  });
  const norm = candidateTitle
    .replace(/^\[(bug|smell)\]\s*/i, '')
    .trim()
    .toLowerCase();
  for (const issue of data) {
    const existing = issue.title
      .replace(/^\[(bug|smell)\]\s*/i, '')
      .trim()
      .toLowerCase();
    if (existing && norm && (existing.includes(norm) || norm.includes(existing))) {
      return issue.number;
    }
  }
  return null;
}
