import { OBELISK_LABELS } from '../../publisher/labels';
import { parseFencedJson } from '../lib/parse-fenced-json';
import {
  fetchKnownIssueTitles,
  normalizeTitle,
  previewTitleConflicts,
} from '../lib/find-existing-issue';
import { listAllPreviewTitlesForRepo } from '../../db/previews';
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

    // Inject the list of already-known findings into the prompt so the
    // agent self-dedups upstream — much more reliable than post-hoc title
    // similarity for cases where the same bug gets reworded run to run
    // (e.g. "Home capstone nodes open the story player" vs "Home capstone
    // path node opens read-only story"). Cap at 80 titles so we don't
    // bloat the prompt on mature repos.
    const knownTitles = await collectKnownTitles(input.repo.id, input.repo.githubFullName);
    const knownBlock =
      knownTitles.length === 0
        ? ''
        : [
            '',
            '## Already-known findings — DO NOT refile',
            '',
            'The titles below are already tracked in this repo, either as open / closed GitHub issues or as local previews (open, dismissed, or published). If your finding describes the same problem (even with different wording), DO NOT include it in BEGIN_FINDINGS. Only emit findings that are genuinely new.',
            '',
            ...knownTitles.slice(0, 80).map((t) => `- ${t}`),
          ].join('\n');

    return {
      task: {
        ref: `plan:${plan.frontmatter.id}`,
        kind: 'sweep',
        context:
          `Run ${plan.frontmatter.name} against ${input.repo.githubFullName}. Execute every test case in the assigned plan and emit findings as JSON.\n\nGenerated at ${ts}.` +
          knownBlock,
        assignedPlan: assigned,
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const findings = parseFindings(input.runResult.reasoning);
    if (findings.length === 0) return [];

    // Dedup pool unifies three sources, key-deduped via collectKnownTitles:
    //   (a) recent previews for this repo (open + dismissed + published) —
    //       catches the recurring-sweep gotcha and respects "not a bug"
    //       dismissals.
    //   (b) obelisk:fix-labeled GitHub issues, both open and recently-
    //       closed — a closed issue is a settled topic.
    //   (c) titles we accept inside this batch, appended as we go.
    const dedupTitles = await collectKnownTitles(input.repo.id, input.repo.githubFullName);

    const out: PublishPlan[] = [];
    for (const f of findings) {
      const title = titleFor(f);
      if (dedupTitles.some((t) => previewTitleConflicts(t, title))) continue;
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f),
        labels: labelsFor(f),
      });
      dedupTitles.push(title);
    }
    return out;
  },
};

async function collectKnownTitles(repoId: string, repoFullName: string): Promise<string[]> {
  const previewTitles = listAllPreviewTitlesForRepo(repoId);
  const issues = await fetchKnownIssueTitles({
    repoFullName,
    label: OBELISK_LABELS.fix,
  }).catch(() => []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...previewTitles, ...issues.map((i) => i.title)]) {
    const key = normalizeTitle(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

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
