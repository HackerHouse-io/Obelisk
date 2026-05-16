import type { ReactElement } from 'react';
import { Icon } from '../../icons';
import type { AuditLine } from '../../../shared/types';
import { parsePublishedFromAudit, parseTargetFromTaskRef, type ParsedTarget } from './helpers';

/**
 * Compact strip above the inspector tabs. Surfaces:
 *  - what the run was **targeting** (issue#42 / pr#36 / plan:foo)
 *  - what the run **produced** (`published` audit rows → PR / issue URL)
 *
 * Renders nothing when both are empty. For PR-Reviewer runs the target
 * is also the outcome, so we skip emitting an "opened" chip that matches
 * the target.
 */
export function OutcomeStrip({
  taskRef,
  auditLog,
  repoFullName,
  planNames,
}: {
  taskRef: string | null;
  auditLog: AuditLine[];
  repoFullName: string | null;
  planNames?: Map<string, string>;
}): ReactElement | null {
  const target = parseTargetFromTaskRef(taskRef, repoFullName, planNames);
  const published = parsePublishedFromAudit(auditLog).filter((p) => {
    // Drop redundancy: a PR Reviewer run will have target=pr#N, and there
    // is no "opened" chip to show anyway. Bug Fixer runs that opened PR
    // for issue#N → keep both (target=issue, outcome=pr).
    if (target?.kind === 'pr' && p.kind === 'pr' && target.label.endsWith(`#${p.number}`)) {
      return false;
    }
    return true;
  });

  if (!target && published.length === 0) return null;

  return (
    <div className="run-inspector-outcome">
      {target ? <TargetChip target={target} /> : null}
      {published.map((p) => (
        <a
          key={`${p.kind}-${p.number}`}
          href={p.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="run-inspector-chip run-inspector-chip-link"
          title={`Open on GitHub: ${p.htmlUrl}`}
        >
          <Icon.GitHub size={11} />
          <span>
            {p.kind === 'pr' ? 'opened PR' : 'filed issue'} #{p.number}
          </span>
          <Icon.External size={10} />
        </a>
      ))}
    </div>
  );
}

function TargetChip({ target }: { target: ParsedTarget }): ReactElement {
  if (target.href) {
    return (
      <a
        href={target.href}
        target="_blank"
        rel="noopener noreferrer"
        className="run-inspector-chip run-inspector-chip-link"
        title={`Open on GitHub: ${target.href}`}
      >
        <Icon.GitHub size={11} />
        <span>{target.label}</span>
        <Icon.External size={10} />
      </a>
    );
  }
  return (
    <span className="run-inspector-chip">
      <span>{target.label}</span>
    </span>
  );
}
