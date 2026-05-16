import type { ReactElement, ReactNode } from 'react';
import { Icon } from '../../icons';
import type { AuditLine, CaseProgressState, TestPlan } from '../../../shared/types';

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="mc-empty">{children}</div>;
}

export function LivePill(): ReactElement {
  return (
    <span className="mc-audit-live" title="Streaming — new entries appear as they arrive">
      <span className="mc-audit-live-dot" aria-hidden="true" />
      Live
    </span>
  );
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

const CASE_STATE_LABEL: Record<CaseProgressState, string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Pass',
  failed: 'Fail',
  inconclusive: 'Inconclusive',
  skipped: 'Skipped',
};

export function CaseStatePill({
  state,
  count,
}: {
  state: CaseProgressState;
  count: number;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <span className={`mc-plan-pill mc-plan-pill-${state}`}>
      {count} {CASE_STATE_LABEL[state]}
    </span>
  );
}

export function CaseStateIcon({ state }: { state: CaseProgressState }): ReactElement {
  if (state === 'running') {
    return (
      <span className="mc-plan-case-icon" aria-label="Running">
        <Icon.Spinner size={12} style={{ animation: 'spin 1s linear infinite' }} />
      </span>
    );
  }
  if (state === 'passed') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-passed" aria-label="Passed">
        <Icon.Check size={12} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-failed" aria-label="Failed">
        <Icon.AlertTri size={12} />
      </span>
    );
  }
  if (state === 'inconclusive') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-inconclusive" aria-label="Inconclusive">
        <Icon.Help size={12} />
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span className="mc-plan-case-icon mc-plan-case-icon-skipped" aria-label="Skipped">
        <Icon.Close size={12} />
      </span>
    );
  }
  return (
    <span className="mc-plan-case-icon mc-plan-case-icon-queued" aria-label="Queued">
      <Icon.Dot size={10} />
    </span>
  );
}

export interface PlanGroup {
  section: { id: string; title: string } | null;
  cases: {
    id: string;
    title: string;
    expected: string | null;
    severity: 'P0' | 'P1' | 'P2' | null;
  }[];
}

export function groupBlocks(plan: TestPlan): PlanGroup[] {
  const groups: PlanGroup[] = [];
  let current: PlanGroup | null = null;
  for (const b of plan.blocks) {
    if (b.kind === 'section') {
      current = { section: { id: b.id, title: b.title }, cases: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { section: null, cases: [] };
        groups.push(current);
      }
      current.cases.push({
        id: b.id,
        title: b.title,
        expected: b.expected,
        severity: b.severity,
      });
    }
  }
  return groups;
}

export function previewText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

export function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function compactResultMeta(content: string): string {
  if (content.length === 0) return 'empty';
  const lineCount = content.split('\n').length;
  if (lineCount === 1) return previewText(content, 60);
  return `${lineCount} lines`;
}

export function firstNonEmpty(text: string): string {
  for (const l of text.split('\n')) {
    if (l.trim().length > 0) return l;
  }
  return text;
}

export interface ParsedTarget {
  kind: 'issue' | 'pr' | 'plan' | 'manual' | 'other';
  label: string;
  href: string | null;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function githubUrl(repoFullName: string | null, kind: 'issues' | 'pull', n: number): string | null {
  if (!repoFullName || !REPO_RE.test(repoFullName)) return null;
  return `https://github.com/${repoFullName}/${kind}/${n}`;
}

/**
 * Decode `run.taskRef` into a clickable target for the OutcomeStrip.
 * - `issue#42` → issue link
 * - `pr#36@<sha>` → PR link (the @sha suffix is just provenance)
 * - `plan:<id>` → plan label (no link); planNames map provides the name
 * - everything else → bare label
 */
export function parseTargetFromTaskRef(
  taskRef: string | null,
  repoFullName: string | null,
  planNames?: Map<string, string>,
): ParsedTarget | null {
  if (!taskRef) return null;
  if (taskRef.startsWith('issue#')) {
    const num = Number(taskRef.slice('issue#'.length).split('@')[0]);
    if (!Number.isFinite(num)) return null;
    return {
      kind: 'issue',
      label: `fixing issue #${num}`,
      href: githubUrl(repoFullName, 'issues', num),
    };
  }
  if (taskRef.startsWith('pr#')) {
    const num = Number(taskRef.slice('pr#'.length).split('@')[0]);
    if (!Number.isFinite(num)) return null;
    return {
      kind: 'pr',
      label: `reviewing PR #${num}`,
      href: githubUrl(repoFullName, 'pull', num),
    };
  }
  if (taskRef.startsWith('plan:')) {
    const planId = taskRef.slice('plan:'.length);
    const name = planNames?.get(planId);
    return {
      kind: 'plan',
      label: name ? `running plan: ${name}` : `running plan: ${planId}`,
      href: null,
    };
  }
  if (taskRef.startsWith('gh:')) {
    const num = Number(taskRef.slice('gh:'.length));
    if (Number.isFinite(num)) {
      return {
        kind: 'issue',
        label: `fixing issue #${num}`,
        href: githubUrl(repoFullName, 'issues', num),
      };
    }
  }
  if (taskRef.startsWith('backlog#') || taskRef.startsWith('manual:')) {
    return { kind: 'manual', label: 'manual task', href: null };
  }
  return { kind: 'other', label: taskRef, href: null };
}

export interface PublishedOutcome {
  kind: 'pr' | 'issue';
  number: number;
  htmlUrl: string;
}

/**
 * Walk the audit log for `kind: 'published'` rows and pull the
 * structured `{ kind, prNumber|issueNumber, htmlUrl }` payload that
 * the orchestrator writes when an evidence-publish succeeds.
 * Dedupes by (kind, number) so reruns don't double up.
 */
export function parsePublishedFromAudit(lines: AuditLine[]): PublishedOutcome[] {
  const seen = new Set<string>();
  const out: PublishedOutcome[] = [];
  for (const l of lines) {
    if (l.kind !== 'published') continue;
    const p = (l.payload ?? {}) as Record<string, unknown>;
    const htmlUrl = typeof p['htmlUrl'] === 'string' ? (p['htmlUrl'] as string) : null;
    if (!htmlUrl) continue;
    if (p['kind'] === 'pr' && typeof p['prNumber'] === 'number') {
      const key = `pr:${p['prNumber']}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'pr', number: p['prNumber'] as number, htmlUrl });
    } else if (p['kind'] === 'issue' && typeof p['issueNumber'] === 'number') {
      const key = `issue:${p['issueNumber']}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'issue', number: p['issueNumber'] as number, htmlUrl });
    }
  }
  return out;
}
