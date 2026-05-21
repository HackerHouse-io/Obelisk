/**
 * Generic parser for the `BEGIN_<TAG> … END_<TAG>` JSON-array convention
 * used by structured-output agents (QA Hunter, Manual QA, future loops).
 *
 * Returns a filtered array of items that match the supplied type guard;
 * returns [] on missing block or malformed JSON.
 */
export function parseFencedJson<T>(
  stdout: string,
  beginTag: string,
  endTag: string,
  isItem: (v: unknown) => v is T,
): T[] {
  const re = new RegExp(`${beginTag}\\s*([\\s\\S]*?)\\s*${endTag}`);
  const match = stdout.match(re);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
}

/**
 * Sibling of `parseFencedJson` for outputs that contain a single JSON
 * object rather than an array (e.g. the refine pipeline's
 * `BEGIN_FINDING … END_FINDING` block). Returns `null` on missing
 * markers, malformed JSON, or type-guard rejection.
 */
export function parseFencedJsonObject<T>(
  stdout: string,
  beginTag: string,
  endTag: string,
  isItem: (v: unknown) => v is T,
): T | null {
  const re = new RegExp(`${beginTag}\\s*([\\s\\S]*?)\\s*${endTag}`);
  const match = stdout.match(re);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    return isItem(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
