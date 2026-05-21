import { createHash } from 'node:crypto';
import { OBELISK_LABELS } from '../../publisher/labels';
import { parseFencedJson } from '../lib/parse-fenced-json';
import {
  fetchKnownIssueTitles,
  normalizeTitle,
  normalizeText,
  previewTitleConflicts,
} from '../lib/find-existing-issue';
import { listAllPreviewTitlesForRepo, listKnownFingerprintsForRepo } from '../../db/previews';
import { resolvePlanForAgentRun, toAssignedPlan } from '../../test-plans/inject';
import type { QaFinding } from '../../../shared/types';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

/**
 * Local alias for the shared structured-finding type. QA Hunter is the
 * primary producer; the refine pipeline in `preview-followup/` is the
 * primary consumer.
 */
export type Finding = QaFinding;

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
  // QA findings always go to previews regardless of repo safety mode —
  // a false-positive run shouldn't be able to spam the user's GitHub.
  alwaysPreview: true,

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
    const { titles: knownTitles } = await collectKnownDedupKeys(
      input.repo.id,
      input.repo.githubFullName,
    );
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
        summary: `Run ${plan.frontmatter.name} on ${input.repo.githubFullName}`,
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

    // Dedup pool unifies three sources, key-deduped via collectKnownDedupKeys:
    //   (a) recent previews for this repo (open + dismissed + published) —
    //       catches the recurring-sweep gotcha and respects "not a bug"
    //       dismissals.
    //   (b) obelisk:fix-labeled GitHub issues, both open and recently-
    //       closed — a closed issue is a settled topic.
    //   (c) titles we accept inside this batch, appended as we go.
    const { titles: dedupTitles, fingerprints: dedupFingerprints } = await collectKnownDedupKeys(
      input.repo.id,
      input.repo.githubFullName,
    );

    const out: PublishPlan[] = [];
    for (const f of findings) {
      const title = titleFor(f);
      const fingerprint = fingerprintFor(f);
      // Fingerprint match wins over title-similarity: the user has
      // already seen this exact content tuple (dismissed it, published
      // it, or it's still open) and we should never re-emit it, even
      // if the agent reworded the title this run.
      if (dedupFingerprints.has(fingerprint)) continue;
      if (dedupTitles.some((t) => previewTitleConflicts(t, title))) continue;
      const labels = labelsFor(f);
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f),
        labels,
        fingerprint,
        finding: { ...f, labels },
      });
      dedupTitles.push(title);
      dedupFingerprints.add(fingerprint);
    }
    return out;
  },
};

interface DedupKeys {
  titles: string[];
  fingerprints: Set<string>;
}

async function collectKnownDedupKeys(repoId: string, repoFullName: string): Promise<DedupKeys> {
  const previewTitles = listAllPreviewTitlesForRepo(repoId);
  const issues = await fetchKnownIssueTitles({
    repoFullName,
    label: OBELISK_LABELS.fix,
  }).catch(() => []);
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const t of [...previewTitles, ...issues.map((i) => i.title)]) {
    const key = normalizeTitle(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(t);
  }
  return { titles, fingerprints: listKnownFingerprintsForRepo(repoId) };
}

/**
 * Stable content fingerprint for a finding. Hashes the normalized title +
 * expected + actual + sorted suspected_files so the identity of a bug
 * survives the agent rewording its title between runs. Used by the dedup
 * pool to hard-drop a re-emitted finding even when title-similarity would
 * miss it.
 */
export function fingerprintFor(f: Finding): string {
  const parts = [
    normalizeText(f.title),
    normalizeText(f.expected),
    normalizeText(f.actual),
    f.suspected_files
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .slice()
      .sort()
      .join(','),
  ].join('\n');
  return createHash('sha256').update(parts).digest('hex');
}

/* ---------- output parsing ---------- */

export function parseFindings(stdout: string): Finding[] {
  return parseFencedJson<Finding>(stdout, 'BEGIN_FINDINGS', 'END_FINDINGS', isFinding);
}

export function isFinding(v: unknown): v is Finding {
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
    (obj['evidence'] === undefined || typeof obj['evidence'] === 'string') &&
    (obj['case_id'] === undefined || typeof obj['case_id'] === 'string') &&
    (obj['labels'] === undefined ||
      (Array.isArray(obj['labels']) && obj['labels'].every((s) => typeof s === 'string')))
  );
}

export function titleFor(f: Finding): string {
  const prefix = f.severity === 'P2' ? '[smell]' : '[bug]';
  return `${prefix} ${f.title}`;
}

/**
 * Inverse of `titleFor`: drops the `[bug]` / `[smell]` prefix so callers
 * (e.g. the follow-up refiner) can hand the raw title back to the model
 * without leaking the rendering convention into the structured form.
 */
export function stripTitlePrefix(title: string): string {
  return title.replace(/^\s*\[(bug|smell)\]\s+/i, '');
}

export function bodyFor(f: Finding): string {
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
  // Trailing HTML comment carries the plan case_id so Mission Control's
  // per-case status map (`derivePerCaseState`) can flip the case to
  // `failed` when the live `CASE_FAIL` marker was lost — the codex
  // runner used to drop them, and historical runs predate that fix.
  // GitHub renders comments as nothing in the issue UI; the regex in
  // `mission-control-helpers.ts` matches `case_id: <id>` either as
  // free text or inside this hidden marker.
  if (f.case_id && f.case_id.trim().length > 0) {
    sections.push('', `<!-- obelisk:case_id=${f.case_id.trim()} -->`);
  }
  return sections.join('\n');
}

function labelsFor(f: Finding): string[] {
  return [OBELISK_LABELS.fix, f.severity];
}

/**
 * Best-effort inverse of `bodyFor`: rebuild a structured Finding from a
 * rendered issue body. Used by the FileIssueModal follow-up refiner when
 * a preview row predates the structured-`finding` payload field (older
 * QA Hunter runs, manual drafts) — we still want the user to be able to
 * chat with the agent, so we re-parse what we have. Missing sections
 * fall back to placeholders that pass `isFinding`'s shape check.
 */
export function parseBodyToFinding(opts: {
  title: string;
  body: string;
  labels: readonly string[];
}): Finding {
  const rawTitle = stripTitlePrefix(opts.title).trim();
  const title = rawTitle.length > 0 ? rawTitle : '(untitled finding)';
  const severity = severityFromLabelsOrBody(opts.labels, opts.body);
  const evidence = unplaceholder(extractSection(opts.body, 'Evidence'));
  const suggested = stripCodeFence(extractSection(opts.body, 'Suggested test'));
  return {
    title,
    severity,
    description: nonEmpty(extractSection(opts.body, 'Description'), title),
    expected: nonEmpty(extractSection(opts.body, 'Expected behavior'), '(unspecified)'),
    actual: nonEmpty(extractSection(opts.body, 'Actual behavior'), '(unspecified)'),
    repro: nonEmpty(extractSection(opts.body, 'Steps to reproduce'), '(unspecified)'),
    ...(evidence ? { evidence } : {}),
    suspected_files: parseFileList(extractSection(opts.body, 'Suspected files')),
    suggested_test: suggested,
    labels: [...opts.labels],
  };
}

function extractSection(body: string, name: string): string {
  // Section content runs until the next `## ` heading or the trailing
  // `> Filed by Obelisk QA Hunter` blockquote (terminator in `bodyFor`).
  const re = new RegExp(
    `^##\\s+${escapeRegex(name)}\\s*$([\\s\\S]*?)(?=^##\\s+|^>\\s+Filed|\\z)`,
    'mi',
  );
  const m = body.match(re);
  return m && m[1] ? m[1].trim() : '';
}

function unplaceholder(s: string): string {
  // bodyFor renders empty sections as italic placeholders like
  // `_(no evidence captured)_`; drop those so the model doesn't think
  // the placeholder is real content.
  const t = s.trim();
  if (/^_\(.*\)_$/.test(t)) return '';
  return t;
}

function nonEmpty(s: string, fallback: string): string {
  const t = unplaceholder(s);
  return t.length > 0 ? t : fallback;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  const fenced = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1]!.trim() : unplaceholder(t);
}

function parseFileList(s: string): string[] {
  const t = unplaceholder(s);
  if (!t) return [];
  const out: string[] = [];
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+`?([^`\n]+?)`?\s*$/);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

function severityFromLabelsOrBody(labels: readonly string[], body: string): 'P0' | 'P1' | 'P2' {
  // Labels are the canonical source (qa-hunter writes `P0|P1|P2` as a
  // bare label); fall back to the `## Severity` section if the labels
  // are stripped or use the legacy `severity:Px` format.
  for (const l of labels) {
    if (l === 'P0' || l === 'P1' || l === 'P2') return l;
    const m = /^severity:(P[012])$/.exec(l);
    if (m) return m[1] as 'P0' | 'P1' | 'P2';
  }
  const sev = extractSection(body, 'Severity').trim();
  if (sev === 'P0' || sev === 'P1' || sev === 'P2') return sev;
  return 'P2';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
