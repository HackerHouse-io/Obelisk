import { fetchKnownIssueTitles, normalizeTitle } from './find-existing-issue';
import { listAllPreviewTitlesForRepo, listKnownFingerprintsForRepo } from '../../db/previews';

export interface DedupKeys {
  titles: string[];
  fingerprints: Set<string>;
}

/**
 * Collect the dedup pool for an issue-filing QA agent: preview titles (open +
 * dismissed + published) unioned with the titles of GitHub issues carrying the
 * agent's provenance `label` (open + recently-closed), plus the content
 * fingerprint set. Each agent passes its own label so the pools stay distinct
 * (e.g. `qa-bug`/`obelisk:fix` vs `ux`). Shared by QA Hunter and the UI/UX
 * Expert; failures fetching GitHub degrade to previews-only.
 */
export async function collectKnownDedupKeys(
  repoId: string,
  repoFullName: string,
  label: string,
): Promise<DedupKeys> {
  const previewTitles = listAllPreviewTitlesForRepo(repoId);
  const issues = await fetchKnownIssueTitles({ repoFullName, label }).catch(() => []);
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
