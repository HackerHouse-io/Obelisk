import { useState, type ReactElement } from 'react';
import type { PreviewedFinding, FindingSeverity } from '../../shared/types';
import { Icon } from '../icons';
import { labelForAgent, shortDate } from '../format';

interface Props {
  finding: PreviewedFinding;
  onOpen: (finding: PreviewedFinding) => void;
  onDismiss?: (finding: PreviewedFinding) => void;
  /**
   * Reverse a "Not a bug" decision so the finding becomes actionable
   * again. Only rendered when `finding.dismissed === true` and the
   * caller passes a handler — i.e. when the FindingsTab's "Show
   * dismissed" toggle is on.
   */
  onUndismiss?: (finding: PreviewedFinding) => void;
  defaultExpanded?: boolean;
}

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  P0: 'bad',
  P1: 'warn',
  P2: 'info',
};

export function FindingPreview({
  finding,
  onOpen,
  onDismiss,
  onUndismiss,
  defaultExpanded = false,
}: Props): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isPublished = finding.published !== null;

  return (
    <div className={`finding-row${finding.dismissed ? ' is-dismissed' : ''}`}>
      <div className="finding-row-head">
        <button
          type="button"
          className="finding-row-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Icon.ChevronDown
            size={11}
            color="var(--t-2)"
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          />
          <SeverityPill severity={finding.severity} />
          <div className="finding-row-title">
            <div className="finding-row-title-text">{finding.title}</div>
            <div className="finding-row-meta">
              <span className="finding-row-meta-item">{labelForAgent(finding.agentName)}</span>
              <span aria-hidden="true">·</span>
              <span className="finding-row-meta-item">{shortDate(finding.at)}</span>
              {finding.evidence.length > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="finding-row-meta-item">
                    <Icon.Camera size={11} color="var(--t-2)" /> {finding.evidence.length}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="finding-row-labels">
            {finding.labels
              .filter((l) => !l.startsWith('severity:'))
              .map((l) => (
                <span key={l} className="pill">
                  {l}
                </span>
              ))}
          </div>
        </button>
        <div className="finding-row-actions">
          {isPublished && finding.published ? (
            <a
              href={finding.published.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn sm finding-row-published"
              title="Open issue on GitHub"
            >
              <Icon.GitHub size={11} /> #{finding.published.issueNumber}
              <Icon.External size={10} />
            </a>
          ) : (
            <>
              <button
                type="button"
                className="btn primary sm"
                onClick={() => onOpen(finding)}
                disabled={finding.dismissed}
                title={
                  finding.dismissed ? 'Marked not a bug' : 'Review and open this issue on GitHub'
                }
              >
                <Icon.Issue size={11} /> Review &amp; open
              </button>
              {onDismiss && !finding.dismissed ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => onDismiss(finding)}
                  title="Mark as not a bug — QA will not flag this again"
                >
                  Not a bug
                </button>
              ) : null}
              {onUndismiss && finding.dismissed ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => onUndismiss(finding)}
                  title='Undo "Not a bug" — finding becomes actionable again'
                >
                  Undismiss
                </button>
              ) : null}
            </>
          )}
          {onDismiss && !finding.dismissed ? (
            <button
              type="button"
              className="btn ghost icon"
              onClick={() => onDismiss(finding)}
              aria-label="Dismiss"
              title={
                isPublished
                  ? 'Hide this from the Task previews list'
                  : 'Dismiss — QA will not flag this again'
              }
              data-testid="finding-row-dismiss"
            >
              <Icon.Close size={11} />
            </button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="finding-row-detail">
          {finding.evidence.length > 0 ? <EvidenceStrip finding={finding} /> : null}
          <pre className="finding-row-body">{finding.body}</pre>
        </div>
      ) : null}
    </div>
  );
}

function SeverityPill({ severity }: { severity: FindingSeverity | null }): ReactElement {
  if (!severity) return <span className="finding-sev-spacer" aria-hidden="true" />;
  return (
    <span className={`pill sev-${severity.toLowerCase()} ${SEVERITY_TONE[severity]}`}>
      {severity}
    </span>
  );
}

export function EvidenceStrip({ finding }: { finding: PreviewedFinding }): ReactElement {
  return (
    <div className="finding-evidence-strip">
      {finding.evidence.map((e) => {
        const url = `obelisk://artifact/${encodeURIComponent(e.id)}`;
        if (e.kind === 'screenshot') {
          return (
            <a
              key={e.id}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="finding-evidence-thumb"
              title={e.basename}
            >
              <img src={url} alt={e.basename} loading="lazy" />
            </a>
          );
        }
        if (e.kind === 'recording') {
          return (
            <video
              key={e.id}
              src={url}
              controls
              preload="metadata"
              className="finding-evidence-video"
              title={e.basename}
            />
          );
        }
        return (
          <a
            key={e.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="finding-evidence-link"
            title={e.basename}
          >
            <Icon.Doc size={11} />
            <span className="mono">
              {e.kind} · {e.basename}
            </span>
          </a>
        );
      })}
    </div>
  );
}
