import matter from 'gray-matter';
import { ulid } from 'ulid';
import type {
  AgentName,
  FindingSeverity,
  TestPlanBlock,
  TestPlanFrontmatter,
  TestPlanScope,
} from '../../shared/types';

/**
 * On-disk format:
 *
 *   ---
 *   id: full-app
 *   name: Full app sweep
 *   scope: whole-app
 *   feature: null
 *   agentName: qa-hunter
 *   generatedAt: 2026-05-05T20:00:00Z
 *   generatedBy: claude
 *   version: 1
 *   ---
 *
 *   ## <Section title>
 *   - [ ] <Case title>          ← severity:P0 optional inline tag at end
 *     - **Expected:** <expected outcome>
 *     - **Repro:** <repro steps>
 *
 * The body parser is forgiving: missing sub-bullets, blank lines, and
 * differing indentation levels all round-trip safely. Anything outside
 * a recognized shape is dropped on save (no silent comment storage).
 */
export interface ParsedPlan {
  frontmatter: TestPlanFrontmatter;
  blocks: TestPlanBlock[];
}

const SEVERITY_TAG = /\s+severity:(P[012])\s*$/;

export function parsePlanFile(raw: string): ParsedPlan {
  const file = matter(raw);
  const fm = normalizeFrontmatter(file.data);
  const blocks = parseBody(file.content);
  return { frontmatter: fm, blocks };
}

export function serializePlan(frontmatter: TestPlanFrontmatter, blocks: TestPlanBlock[]): string {
  const fmYaml = [
    `id: ${frontmatter.id}`,
    `name: ${quoteIfNeeded(frontmatter.name)}`,
    `scope: ${frontmatter.scope}`,
    `feature: ${frontmatter.feature ? quoteIfNeeded(frontmatter.feature) : 'null'}`,
    `agentName: ${frontmatter.agentName}`,
    `generatedAt: ${frontmatter.generatedAt}`,
    `generatedBy: ${frontmatter.generatedBy}`,
    `version: ${frontmatter.version}`,
  ].join('\n');

  const body = renderBody(blocks);
  return `---\n${fmYaml}\n---\n\n${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderBody(blocks: TestPlanBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'section') {
      lines.push('', `## ${b.title.trim()}`, '');
      continue;
    }
    const sevTag = b.severity ? ` severity:${b.severity}` : '';
    lines.push(`- [ ] ${b.title.trim()}${sevTag}`);
    if (b.expected && b.expected.trim()) {
      lines.push(`  - **Expected:** ${b.expected.trim()}`);
    }
    if (b.repro && b.repro.trim()) {
      lines.push(`  - **Repro:** ${b.repro.trim()}`);
    }
  }
  return lines.join('\n').trim();
}

function parseBody(content: string): TestPlanBlock[] {
  const blocks: TestPlanBlock[] = [];
  let lastCase: Extract<TestPlanBlock, { kind: 'case' }> | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const sectionMatch = /^##\s+(.*)$/.exec(line);
    if (sectionMatch) {
      blocks.push({ kind: 'section', id: ulid(), title: sectionMatch[1]!.trim() });
      lastCase = null;
      continue;
    }
    const caseMatch = /^-\s*\[[ xX]\]\s+(.*)$/.exec(line);
    if (caseMatch) {
      let title = caseMatch[1]!.trim();
      let severity: FindingSeverity | null = null;
      const sev = SEVERITY_TAG.exec(title);
      if (sev) {
        severity = sev[1] as FindingSeverity;
        title = title.replace(SEVERITY_TAG, '').trim();
      }
      const c = {
        kind: 'case' as const,
        id: ulid(),
        title,
        expected: null,
        repro: null,
        severity,
      };
      blocks.push(c);
      lastCase = c;
      continue;
    }
    if (!lastCase) continue;
    const expectedMatch = /^\s*-\s+\*\*Expected:\*\*\s*(.*)$/i.exec(line);
    if (expectedMatch) {
      lastCase.expected = expectedMatch[1]!.trim();
      continue;
    }
    const reproMatch = /^\s*-\s+\*\*Repro:\*\*\s*(.*)$/i.exec(line);
    if (reproMatch) {
      lastCase.repro = reproMatch[1]!.trim();
      continue;
    }
  }
  return blocks;
}

function normalizeFrontmatter(raw: Record<string, unknown>): TestPlanFrontmatter {
  const id = stringField(raw, 'id');
  if (!id) throw new Error('test plan frontmatter missing required `id`');
  const name = stringField(raw, 'name') ?? id;
  const scope = (stringField(raw, 'scope') ?? 'whole-app') as TestPlanScope;
  const feature = stringField(raw, 'feature');
  const agentName = (stringField(raw, 'agentName') ?? 'qa-hunter') as AgentName;
  const generatedAt = stringField(raw, 'generatedAt') ?? new Date().toISOString();
  const generatedBy = (stringField(raw, 'generatedBy') ??
    'manual') as TestPlanFrontmatter['generatedBy'];
  const versionRaw = raw['version'];
  const version = typeof versionRaw === 'number' ? versionRaw : 1;
  return {
    id,
    name,
    scope: scope === 'feature' ? 'feature' : 'whole-app',
    feature: scope === 'feature' ? (feature ?? null) : null,
    agentName,
    generatedAt,
    generatedBy,
    version,
  };
}

function stringField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v !== 'null' ? v : null;
}

function quoteIfNeeded(s: string): string {
  return /[:#\n"']/.test(s) ? JSON.stringify(s) : s;
}

export function countCases(blocks: TestPlanBlock[]): number {
  return blocks.reduce((n, b) => (b.kind === 'case' ? n + 1 : n), 0);
}
