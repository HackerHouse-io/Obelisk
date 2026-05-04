import { ulid } from 'ulid';
import { getGithub } from '../../github/client';
import { OBELISK_LABELS } from '../../publisher/labels';
import { parseFencedJson } from '../lib/parse-fenced-json';
import type {
  AgentHandler,
  SelectTaskInput,
  SelectedTask,
  InterpretResultInput,
  PublishPlan,
} from '../types';

export const qaHunterHandler: AgentHandler = {
  name: 'qa-hunter',
  // Singleton: a 2nd QA Hunter would do a redundant whole-repo sweep.
  multiInstance: false,
  addAnotherExplainer:
    'QA Hunter sweeps the whole repo on every run — only one instance is useful.',
  // QA Hunter doesn't write code; it files issues. The Evidence Pack gate
  // (which is about PR evidence) doesn't apply.
  skipsEvidenceGate: true,
  producesPatch: false,

  async selectTask(input: SelectTaskInput): Promise<SelectedTask | null> {
    // QA Hunter sweeps the entire repo on a schedule. Synthesize a single
    // task per run; there's no backlog item to lock.
    const ts = new Date().toISOString();
    return {
      task: {
        ref: `sweep:${input.repo.id}:${ulid()}`,
        kind: 'sweep',
        context: `Scan ${input.repo.githubFullName} for likely bugs and weak coverage. Output as JSON.\n\nGenerated at ${ts}.`,
      },
    };
  },

  async interpretResult(input: InterpretResultInput): Promise<PublishPlan[]> {
    const findings = parseFindings(input.runResult.reasoning);
    if (findings.length === 0) return [];

    const out: PublishPlan[] = [];
    for (const f of findings) {
      const title = titleFor(f);
      const dup = await findDuplicateIssue(input.repo.githubFullName, title).catch(() => null);
      if (dup !== null) continue; // already filed; skip silently (audit log records the count diff)
      out.push({
        kind: 'issue',
        title,
        body: bodyFor(f),
        labels: labelsFor(f),
      });
    }
    return out;
  },
};

/* ---------- output parsing ---------- */

interface Finding {
  title: string;
  severity: 'P0' | 'P1' | 'P2';
  repro: string;
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
    typeof obj['repro'] === 'string' &&
    Array.isArray(obj['suspected_files']) &&
    obj['suspected_files'].every((f) => typeof f === 'string') &&
    typeof obj['suggested_test'] === 'string'
  );
}

function titleFor(f: Finding): string {
  const prefix = f.severity === 'P0' ? '[bug]' : f.severity === 'P1' ? '[bug]' : '[smell]';
  return `${prefix} ${f.title}`;
}

function bodyFor(f: Finding): string {
  return [
    `## Severity`,
    f.severity,
    '',
    `## Repro`,
    f.repro || '_(QA Hunter did not produce repro steps)_',
    '',
    `## Suspected files`,
    f.suspected_files.length === 0
      ? '_(none identified)_'
      : f.suspected_files.map((p) => `- \`${p}\``).join('\n'),
    '',
    `## Suggested test`,
    `\`\`\`\n${f.suggested_test}\n\`\`\``,
    '',
    `> Filed by Obelisk QA Hunter. Reply \`/obelisk fix\` to assign Bug Fixer to this issue.`,
  ].join('\n');
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
