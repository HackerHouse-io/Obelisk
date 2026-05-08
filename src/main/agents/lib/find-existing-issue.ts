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
 * Two QA-style titles "conflict" when, after stripping the prefix, they
 * are either an exact match, one is a substring of the other, OR their
 * tokenized-and-stop-word-filtered Jaccard similarity is ≥ 0.7. The
 * Jaccard step is what catches near-duplicates like "X can never Y" vs
 * "X never Y" where the only difference is a stop word.
 */
export function titleConflicts(existing: string, candidate: string, prefix: string): boolean {
  const a = stripPrefix(existing, prefix);
  const b = stripPrefix(candidate, prefix);
  return titlesAreSimilar(a, b);
}

function stripPrefix(title: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return normalizeTitle(title.replace(new RegExp(`^${escaped}\\s*`, 'i'), ''));
}

/**
 * Agent-agnostic title-conflict check used to dedup against open previews.
 * Strips any leading bracket prefix (e.g. `[bug]`, `[smell]`, `[QA Bug]`,
 * `[QA iOS]`) before comparing, so a finding from one agent dedups against
 * a preview filed by another.
 */
export function previewTitleConflicts(existing: string, candidate: string): boolean {
  const a = stripAnyBracketPrefix(existing);
  const b = stripAnyBracketPrefix(candidate);
  return titlesAreSimilar(a, b);
}

function stripAnyBracketPrefix(title: string): string {
  return normalizeTitle(title.replace(/^\s*\[[^\]]+\]\s*/i, ''));
}

/** Single source of truth for title normalization across dedup callsites. */
export function normalizeTitle(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Title-equivalence test. Catches three flavours of near-duplicate that
 * a pure-substring check misses:
 *
 *   1. Exact match (case-insensitive, post-prefix-strip).
 *   2. One title contains the other (genuine extension — "Reset" inside
 *      "Reset progress leaves streak state behind").
 *   3. Their token sets, after lowercasing + dropping stop words + light
 *      stemming, agree by Jaccard ≥ 0.7. This is the case that previously
 *      slipped through and let QA Hunter file "X can never Y" alongside
 *      an existing "X never Y" — the tokens match identically once "can"
 *      is filtered as a stop word.
 *
 * Threshold tuned to 0.7: pairs sharing ≥70% of meaningful tokens are
 * almost always the same finding reworded; below that, false positives
 * start dominating (e.g. two unrelated "Profile" bugs).
 */
export function titlesAreSimilar(a: string, b: string, threshold = 0.7): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = tokenSetForSimilarity(a);
  const tb = tokenSetForSimilarity(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union > 0 && intersection / union >= threshold;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'or',
  'but',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'up',
  'about',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  's',
  't',
  'can',
  'will',
  'just',
  'don',
  'should',
  'now',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'myself',
  'we',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'he',
  'him',
  'his',
  'himself',
  'she',
  'her',
  'hers',
  'herself',
  'it',
  'its',
  'itself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
  'what',
  'which',
  'who',
  'whom',
]);

function tokenSetForSimilarity(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function stem(w: string): string {
  // Lightweight suffix stripping — enough to collapse node/nodes,
  // open/opens/opening, complete/completes/completed/completing, etc.
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
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

/**
 * Fetch BOTH open and recently-closed issues with the given label. Closed
 * counts because: a user closing an obelisk-filed issue (whether as
 * "fixed", "won't fix", or "duplicate") is a vote that the topic is
 * resolved — re-filing a near-duplicate would be noise.
 *
 * Returns up to 100 each so we have a healthy pool for fuzzy matching.
 */
export async function fetchKnownIssueTitles(opts: {
  repoFullName: string;
  label: string;
}): Promise<{ number: number; title: string; state: 'open' | 'closed' }[]> {
  try {
    const gh = await getGithub();
    if (!gh) return [];
    const [owner, name] = opts.repoFullName.split('/');
    if (!owner || !name) return [];
    const [openR, closedR] = await Promise.all([
      gh.issues.listForRepo({
        owner,
        repo: name,
        labels: opts.label,
        state: 'open',
        per_page: 100,
      }),
      gh.issues.listForRepo({
        owner,
        repo: name,
        labels: opts.label,
        state: 'closed',
        per_page: 100,
        sort: 'updated',
        direction: 'desc',
      }),
    ]);
    return [
      ...openR.data.map((d) => ({ number: d.number, title: d.title, state: 'open' as const })),
      ...closedR.data.map((d) => ({ number: d.number, title: d.title, state: 'closed' as const })),
    ];
  } catch {
    return [];
  }
}
