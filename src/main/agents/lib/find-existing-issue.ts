import { getGithub } from '../../github/client';

export interface ExistingIssueRef {
  number: number;
  title: string;
}

/**
 * Look up an open GitHub issue that already covers the same flow / symptom,
 * so QA agents can append a comment instead of opening a duplicate.
 *
 * `prefix` is the title prefix the agent uses (e.g. `[QA Bug]`, `[QA iOS]`).
 * `candidateTitle` is the full title the agent would otherwise file.
 * `label` filters the search server-side.
 *
 * Returns the first conflicting open issue or null. Failures (no GitHub
 * client, network error) return null — caller falls back to filing a new
 * issue, which is the same behaviour as before this lib existed.
 */
export async function findOpenIssueForFlow(opts: {
  repoFullName: string;
  prefix: string;
  candidateTitle: string;
  label: string;
}): Promise<ExistingIssueRef | null> {
  try {
    const gh = await getGithub();
    if (!gh) return null;
    const [owner, name] = opts.repoFullName.split('/');
    if (!owner || !name) return null;
    const { data } = await gh.issues.listForRepo({
      owner,
      repo: name,
      labels: opts.label,
      state: 'open',
      per_page: 100,
    });
    for (const issue of data) {
      if (titleConflicts(issue.title, opts.candidateTitle, opts.prefix)) {
        return { number: issue.number, title: issue.title };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Two QA-style titles "conflict" when, after stripping the prefix, one
 * substring-contains the other. Loose on purpose: a re-discovery of the
 * same bug rarely produces an exact title match, but the flow identifier
 * usually appears in both.
 */
export function titleConflicts(existing: string, candidate: string, prefix: string): boolean {
  const a = stripPrefix(existing, prefix);
  const b = stripPrefix(candidate, prefix);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function stripPrefix(title: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(new RegExp(`^${escaped}\\s*`, 'i'), '')
    .trim()
    .toLowerCase();
}

/**
 * Agent-agnostic title-conflict check used to dedup against open previews.
 * Strips any leading bracket prefix (e.g. `[bug]`, `[smell]`, `[QA Bug]`,
 * `[QA iOS]`) before comparing, so a finding from one agent dedups against
 * a preview filed by another. Same substring-either-direction logic as
 * `titleConflicts`.
 */
export function previewTitleConflicts(existing: string, candidate: string): boolean {
  const a = stripAnyBracketPrefix(existing);
  const b = stripAnyBracketPrefix(candidate);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function stripAnyBracketPrefix(title: string): string {
  return title
    .replace(/^\s*\[[^\]]+\]\s*/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Convenience for callers that only need the title list (e.g. legacy
 * Manual QA dedup that compares against many candidate titles in one pass).
 */
export async function fetchOpenIssueTitles(opts: {
  repoFullName: string;
  label: string;
}): Promise<{ number: number; title: string }[]> {
  try {
    const gh = await getGithub();
    if (!gh) return [];
    const [owner, name] = opts.repoFullName.split('/');
    if (!owner || !name) return [];
    const { data } = await gh.issues.listForRepo({
      owner,
      repo: name,
      labels: opts.label,
      state: 'open',
      per_page: 100,
    });
    return data.map((d) => ({ number: d.number, title: d.title }));
  } catch {
    return [];
  }
}
