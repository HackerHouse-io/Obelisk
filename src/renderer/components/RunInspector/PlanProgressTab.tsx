import { useMemo, useState, type ReactElement } from 'react';
import type {
  AuditLine,
  FindingSeverity,
  PreviewedFinding,
  RunState,
  TestPlan,
} from '../../../shared/types';
import { Icon } from '../../icons';
import { showApiAlert } from '../../state/alert-store';
import { EvidenceStrip } from '../FindingPreview';
import {
  buildFailureContexts,
  countByState,
  derivePerCaseState,
  type FailureContext,
  type UntrackedMarker,
} from '../../screens/mission-control-helpers';
import { CaseStateIcon, CaseStatePill, groupBlocks } from './helpers';

/** Live plan-progress view. State derivation lives in `derivePerCaseState`. */
export function PlanProgressTab({
  plan,
  auditLog,
  findings,
  runState,
  runId,
  onOpenFinding,
  readOnly = false,
}: {
  plan: TestPlan;
  auditLog: AuditLine[];
  findings: PreviewedFinding[];
  runState: RunState;
  runId: string;
  /**
   * Open a PreviewedFinding in the FileIssueModal. Receives either an
   * existing finding (linked to the failed case) or the freshly-created
   * manual-draft preview returned by `previews:createDraftFromCase`.
   * Omit to hide all "File issue" affordances (e.g. for the Archive
   * screen's read-only inspector).
   */
  onOpenFinding?: (f: PreviewedFinding) => void;
  readOnly?: boolean;
}): ReactElement {
  const { byCase, untracked } = useMemo(
    () => derivePerCaseState({ plan, auditLog, findings, runState }),
    [plan, auditLog, findings, runState],
  );
  const counts = useMemo(() => countByState(byCase), [byCase]);
  const groups = useMemo(() => groupBlocks(plan), [plan]);
  const failureContexts = useMemo(
    () => buildFailureContexts({ plan, byCase, auditLog, findings }),
    [plan, byCase, auditLog, findings],
  );
  const total = plan.caseCount;

  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const [draftingCaseId, setDraftingCaseId] = useState<string | null>(null);

  const canFileIssue = !readOnly && typeof onOpenFinding === 'function';

  async function fileIssueManually(ctx: FailureContext): Promise<void> {
    if (!onOpenFinding) return;
    setDraftingCaseId(ctx.caseId);
    try {
      const res = await window.obelisk.invoke('previews:createDraftFromCase', {
        runId,
        caseId: ctx.caseId,
        caseTitle: ctx.caseTitle,
        expected: ctx.expected,
        repro: ctx.repro,
        severity: ctx.severity,
        failureDetail: ctx.auditDetail,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'create draft issue');
        return;
      }
      onOpenFinding(res.value);
    } finally {
      setDraftingCaseId(null);
    }
  }

  return (
    <div className="mc-plan">
      <header className="mc-plan-summary">
        <div className="mc-plan-summary-title">{plan.frontmatter.name}</div>
        <div className="mc-plan-summary-counts">
          <CaseStatePill state="passed" count={counts.passed} />
          <CaseStatePill state="failed" count={counts.failed} />
          <CaseStatePill state="running" count={counts.running} />
          <CaseStatePill state="inconclusive" count={counts.inconclusive} />
          <CaseStatePill state="queued" count={counts.queued} />
          <CaseStatePill state="skipped" count={counts.skipped} />
        </div>
        {untracked.length > 0 ? <UntrackedMarkerNote markers={untracked} /> : null}
        <div className="mc-plan-progress-bar">
          <div
            className="mc-plan-progress-fill"
            style={{
              width: `${total === 0 ? 0 : Math.round(((counts.passed + counts.failed + counts.inconclusive + counts.skipped) / total) * 100)}%`,
            }}
          />
        </div>
      </header>

      <div className="mc-plan-body">
        {groups.map((g) => (
          <section className="mc-plan-section" key={g.section?.id ?? `unsec-${g.cases[0]?.id}`}>
            {g.section ? (
              <div className="mc-plan-section-head">
                <div className="mc-plan-section-title">{g.section.title}</div>
                <div className="mc-plan-section-count">
                  {g.cases.length} case{g.cases.length === 1 ? '' : 's'}
                </div>
              </div>
            ) : null}
            <ol className="mc-plan-cases">
              {g.cases.map((c) => {
                const state = byCase.get(c.id) ?? 'queued';
                const ctx = state === 'failed' ? (failureContexts.get(c.id) ?? null) : null;
                const isExpanded = expandedCaseId === c.id;
                return (
                  <li key={c.id} className={`mc-plan-case mc-plan-case-${state}`}>
                    {ctx ? (
                      <button
                        type="button"
                        className="mc-plan-case-head mc-plan-case-head-clickable"
                        aria-expanded={isExpanded}
                        onClick={() => setExpandedCaseId(isExpanded ? null : c.id)}
                      >
                        <PlanCaseRow
                          caseRow={c}
                          state={state}
                          chevron={true}
                          expanded={isExpanded}
                        />
                      </button>
                    ) : (
                      <div className="mc-plan-case-head">
                        <PlanCaseRow caseRow={c} state={state} chevron={false} expanded={false} />
                      </div>
                    )}
                    {ctx && isExpanded ? (
                      <FailedCaseDetail
                        ctx={ctx}
                        canFileIssue={canFileIssue}
                        isDrafting={draftingCaseId === ctx.caseId}
                        onOpenFinding={onOpenFinding}
                        onFileManually={() => void fileIssueManually(ctx)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function PlanCaseRow({
  caseRow,
  state,
  chevron,
  expanded,
}: {
  caseRow: { id: string; title: string; expected: string | null; severity: FindingSeverity | null };
  state: import('../../../shared/types').CaseProgressState;
  chevron: boolean;
  expanded: boolean;
}): ReactElement {
  return (
    <>
      <CaseStateIcon state={state} />
      {caseRow.severity ? (
        <span className={`pill sev-${caseRow.severity.toLowerCase()}`}>{caseRow.severity}</span>
      ) : (
        <span className="mc-plan-case-sev-spacer" aria-hidden="true" />
      )}
      <div className="mc-plan-case-body">
        <div className="mc-plan-case-title">{caseRow.title}</div>
        {caseRow.expected ? (
          <div className="mc-plan-case-meta">
            <span className="mc-plan-case-meta-key">Expected:</span> {caseRow.expected}
          </div>
        ) : null}
      </div>
      {chevron ? (
        <span
          className="mc-plan-case-chevron"
          style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          aria-hidden="true"
        >
          <Icon.ChevronDown size={11} color="var(--t-2)" />
        </span>
      ) : null}
    </>
  );
}

function renderFindingAction(
  finding: PreviewedFinding,
  canFileIssue: boolean,
  onOpenFinding: ((f: PreviewedFinding) => void) | undefined,
): ReactElement | null {
  if (finding.published) {
    return (
      <a
        href={finding.published.htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn sm"
        title="Open issue on GitHub"
      >
        <Icon.GitHub size={11} /> #{finding.published.issueNumber}
        <Icon.External size={10} />
      </a>
    );
  }
  if (!canFileIssue || !onOpenFinding) return null;
  return (
    <button
      type="button"
      className="btn primary sm"
      onClick={() => onOpenFinding(finding)}
      disabled={finding.dismissed}
      title={finding.dismissed ? 'Marked not a bug' : 'Review and open this issue on GitHub'}
    >
      <Icon.Issue size={11} /> Review &amp; open issue on GitHub
    </button>
  );
}

function FailedCaseDetail({
  ctx,
  canFileIssue,
  isDrafting,
  onOpenFinding,
  onFileManually,
}: {
  ctx: FailureContext;
  canFileIssue: boolean;
  isDrafting: boolean;
  onOpenFinding?: (f: PreviewedFinding) => void;
  onFileManually: () => void;
}): ReactElement {
  const finding = ctx.finding;
  if (finding) {
    return (
      <div className="mc-plan-case-detail">
        {finding.evidence.length > 0 ? <EvidenceStrip finding={finding} /> : null}
        <pre className="mc-plan-case-detail-body">{finding.body}</pre>
        <div className="mc-plan-case-detail-actions">
          {renderFindingAction(finding, canFileIssue, onOpenFinding)}
        </div>
      </div>
    );
  }
  return (
    <div className="mc-plan-case-detail">
      <div className="mc-plan-case-detail-reason">
        {ctx.auditDetail ? (
          <>
            <span className="mc-plan-case-detail-key">Reason:</span> {ctx.auditDetail}
          </>
        ) : (
          <em>
            The agent marked this case as failed but did not record a reason or file a finding.
          </em>
        )}
      </div>
      {ctx.expected ? (
        <div className="mc-plan-case-detail-reason">
          <span className="mc-plan-case-detail-key">Expected:</span> {ctx.expected}
        </div>
      ) : null}
      {canFileIssue ? (
        <div className="mc-plan-case-detail-actions">
          <button
            type="button"
            className="btn primary sm"
            onClick={onFileManually}
            disabled={isDrafting}
            title="Compose a GitHub issue from this failed case"
          >
            {isDrafting ? (
              <>
                <Icon.Spinner size={11} /> Drafting…
              </>
            ) : (
              <>
                <Icon.GitHub size={11} /> File issue manually
              </>
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UntrackedMarkerNote({ markers }: { markers: UntrackedMarker[] }): ReactElement {
  const sample = markers.slice(0, 3).map((m) => m.caseId);
  const more = markers.length - sample.length;
  const full = markers.map((m) => `${m.caseId} (${m.status})`).join(', ');
  return (
    <small className="mc-plan-untracked" title={full}>
      +{markers.length} untracked marker{markers.length === 1 ? '' : 's'} from the agent —{' '}
      <span className="mono">{sample.join(', ')}</span>
      {more > 0 ? ` +${more} more` : ''}
    </small>
  );
}
