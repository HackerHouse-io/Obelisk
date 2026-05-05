import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface MarkdownFile {
  /** Path relative to the `root` passed to walkMarkdownFiles. */
  relPath: string;
  contents: string;
  mtimeMs: number;
}

/**
 * Walk a directory recursively, returning every `.md` file beneath it.
 * Skips dotfiles. Errors (missing dir, unreadable file) are swallowed —
 * callers treat the result as best-effort.
 */
export function walkMarkdownFiles(root: string): MarkdownFile[] {
  const out: MarkdownFile[] = [];
  visit(root, root, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function visit(root: string, dir: string, out: MarkdownFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      visit(root, full, out);
    } else if (s.isFile() && name.toLowerCase().endsWith('.md')) {
      try {
        out.push({
          relPath: relative(root, full),
          contents: readFileSync(full, 'utf8'),
          mtimeMs: s.mtimeMs,
        });
      } catch {
        // ignore unreadable file
      }
    }
  }
}
