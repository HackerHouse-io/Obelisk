import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  AuditLine,
  EvidenceItem,
  PreviewedFinding,
  Run,
  TestPlan,
  TestPlanSummary,
} from '../../../shared/types';
import { parsePlanIdFromTaskRef } from '../../../shared/task-refs';
import { showApiAlert } from '../../state/alert-store';
import { FileIssueModal } from '../FileIssueModal';
import { UndoToast } from '../UndoToast';
import { ActivityTab } from './ActivityTab';
import { EvidenceTab } from './EvidenceTab';
import { FilesTab } from './FilesTab';
import { FindingsTab } from './FindingsTab';
import { OutcomeStrip } from './OutcomeStrip';
import { PlanProgressTab } from './PlanProgressTab';
import { ReasoningTab } from './ReasoningTab';

type Tab = 'plan' | 'findings' | 'activity' | 'evidence' | 'reasoning' | 'files';

export interface RunInspectorProps {
  run: Run;
  /**
   * When true, the inspector renders write controls as read-only:
   * Findings tab hides Dismiss / Undismiss, the FileIssueModal opens for
   * viewing but its submit is disabled, no undo toasts, and no live bus
   * subscription (archived runs are terminal).
   */
  readOnly?: boolean;
  repoFullName: string | null;
}

/**
 * Shared run-detail inspector mounted by Mission Control's drawer and by
 * the Archive screen. Owns the data fetches (runs:get, previews:list,
 * testPlans:get), the tab routing, the FileIssueModal, and the undo-toast
 * stack. Self-contained — parents only pass the run + readOnly + repo.
 */
export function RunInspector({
  run,
  readOnly = false,
  repoFullName,
}: RunInspectorProps): ReactElement {
  const [details, setDetails] = useState<{
    auditLog: AuditLine[];
    evidence: EvidenceItem[];
  } | null>(null);
  const [findings, setFindings] = useState<PreviewedFinding[]>([]);
  const [plan, setPlan] = useState<TestPlan | null>(null);
  const [planSummaries, setPlanSummaries] = useState<TestPlanSummary[]>([]);
  const [tab, setTab] = useState<Tab>('activity');
  const [modalFinding, setModalFinding] = useState<PreviewedFinding | null>(null);
  const [undoToasts, setUndoToasts] = useState<{ id: number; title: string }[]>([]);

  const refreshDetails = useCallback(async (runId: string) => {
    const res = await window.obelisk.invoke('runs:get', { runId });
    if (res.ok) setDetails({ auditLog: res.value.auditLog, evidence: res.value.evidence });
  }, []);

  const refreshFindings = useCallback(async (runId: string, repoId: string) => {
    const res = await window.obelisk.invoke('previews:list', { repoId });
    if (!res.ok) return;
    setFindings(res.value.findings.filter((f) => f.runId === runId));
  }, []);

  // Reset and fetch all three data sources when the inspected run changes.
  useEffect(() => {
    setDetails(null);
    setFindings([]);
    setPlan(null);
    let cancelled = false;
    void refreshDetails(run.id);
    void refreshFindings(run.id, run.repoId);
    const planId = parsePlanIdFromTaskRef(run.taskRef);
    if (planId) {
      void window.obelisk.invoke('testPlans:get', { planId, repoId: run.repoId }).then((res) => {
        if (cancelled) return;
        setPlan(res.ok ? res.value : null);
      });
    }
    // Plan-name lookup for OutcomeStrip's `plan:<id>` target chip.
    void window.obelisk.invoke('testPlans:list', { repoId: run.repoId }).then((res) => {
      if (cancelled) return;
      if (res.ok) setPlanSummaries(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [run.id, run.repoId, run.taskRef, refreshDetails, refreshFindings]);

  // Live updates — only while the run is mutable. Archived (read-only)
  // runs are terminal; skip the subscription to avoid spurious refetches.
  useEffect(() => {
    if (readOnly) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'previews.changed' && evt.repoId === run.repoId) {
        void refreshFindings(run.id, run.repoId);
        return;
      }
      if (
        (evt.type === 'run.audit' && evt.runId === run.id) ||
        (evt.type === 'run.caseProgress' && evt.runId === run.id) ||
        (evt.type === 'run.transition' && evt.runId === run.id)
      ) {
        void refreshDetails(run.id);
      }
    });
  }, [run.id, run.repoId, readOnly, refreshDetails, refreshFindings]);

  const hasFindings = findings.filter((f) => !f.dismissed).length > 0;
  const isTerminal = run.state === 'done' || run.state === 'failed' || run.state === 'cancelled';

  // Default-tab selection. Re-runs only when the inspected run id flips.
  const tabSetForRun = useRef<string | null>(null);
  useEffect(() => {
    if (tabSetForRun.current === run.id) return;
    tabSetForRun.current = run.id;
    if (run.state === 'failed') setTab('activity');
    else if (plan) setTab('plan');
    else if (hasFindings && isTerminal) setTab('findings');
    else setTab('activity');
  }, [run.id, run.state, plan, hasFindings, isTerminal]);

  const planNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of planSummaries) m.set(p.id, p.name);
    return m;
  }, [planSummaries]);

  async function dismissFinding(f: PreviewedFinding): Promise<void> {
    if (readOnly) return;
    const res = await window.obelisk.invoke('previews:dismiss', { previewId: f.id });
    if (!res.ok) {
      showApiAlert(res.error, 'dismiss finding');
      return;
    }
    setUndoToasts((prev) => [...prev, { id: f.id, title: f.title }]);
  }

  async function undismissPreview(previewId: number): Promise<void> {
    if (readOnly) return;
    const res = await window.obelisk.invoke('previews:undismiss', { previewId });
    if (!res.ok) showApiAlert(res.error, 'restore finding');
  }

  const visibleTabs: Tab[] = [
    ...(plan ? (['plan'] as Tab[]) : []),
    ...(hasFindings ? (['findings'] as Tab[]) : []),
    ...(['activity', 'evidence', 'reasoning', 'files'] as Tab[]),
  ];

  return (
    <div className="run-inspector">
      <OutcomeStrip
        taskRef={run.taskRef}
        auditLog={details?.auditLog ?? []}
        repoFullName={repoFullName}
        planNames={planNames}
      />
      <div className="mc-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            className={`mc-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'findings'
              ? `findings (${findings.filter((f) => !f.dismissed).length})`
              : t === 'plan' && plan
                ? `plan (${plan.caseCount})`
                : t}
          </button>
        ))}
      </div>
      <div className="mc-tab-body">
        {tab === 'plan' && plan && (
          <PlanProgressTab
            plan={plan}
            auditLog={details?.auditLog ?? []}
            findings={findings}
            runState={run.state}
            runId={run.id}
            onOpenFinding={setModalFinding}
            readOnly={readOnly}
          />
        )}
        {tab === 'findings' && (
          <FindingsTab
            findings={findings}
            onOpen={setModalFinding}
            onDismiss={readOnly ? undefined : dismissFinding}
            onUndismiss={readOnly ? undefined : (f) => void undismissPreview(f.id)}
            readOnly={readOnly}
          />
        )}
        {tab === 'activity' && (
          <ActivityTab
            lines={details?.auditLog ?? []}
            runState={run.state}
            errorCode={run.errorCode}
            outputSummary={run.outputSummary}
          />
        )}
        {tab === 'evidence' && <EvidenceTab evidence={details?.evidence ?? []} />}
        {tab === 'reasoning' && <ReasoningTab lines={details?.auditLog ?? []} />}
        {tab === 'files' && <FilesTab evidence={details?.evidence ?? []} />}
      </div>
      <FileIssueModal
        open={modalFinding !== null}
        finding={modalFinding}
        onClose={() => setModalFinding(null)}
        onFiled={() => {
          // previews.changed bus broadcast triggers refresh.
        }}
        readOnly={readOnly}
      />
      {!readOnly && undoToasts.length > 0 ? (
        <div className="undo-toast-stack" aria-live="polite">
          {undoToasts.map((t) => (
            <UndoToast
              key={t.id}
              message={`Marked "${t.title}" as not a bug`}
              onUndo={() => void undismissPreview(t.id)}
              onClose={() => setUndoToasts((prev) => prev.filter((x) => x.id !== t.id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
