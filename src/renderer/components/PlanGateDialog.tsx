import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { Agent, AgentName, TestPlanScope, TestPlanSummary } from '../../shared/types';
import { Icon } from '../icons';
import { labelForAgent, shortDate } from '../format';

export type PlanGateState =
  | { kind: 'closed' }
  | { kind: 'noPlan'; agent: Agent; busy: boolean; error: string | null }
  | {
      kind: 'newPlanForm';
      agent: Agent;
      scope: TestPlanScope;
      featureName: string;
      busy: boolean;
      error: string | null;
    }
  | { kind: 'pick'; agent: Agent; plans: TestPlanSummary[] };

interface Props {
  state: PlanGateState;
  onClose: () => void;
  onAdvanceFromNoPlan: () => void;
  onGenerate: (input: { scope: TestPlanScope; featureName?: string }) => void;
  onPick: (planId: string) => void;
  onAddNewFromPicker: () => void;
}

/**
 * The "QA agent needs a test plan" gate. Three forms in one component so
 * the user can transition smoothly: see the no-plan empty state, click
 * Generate, fill scope, submit; or pick from existing plans.
 */
export function PlanGateDialog({
  state,
  onClose,
  onAdvanceFromNoPlan,
  onGenerate,
  onPick,
  onAddNewFromPicker,
}: Props): ReactElement | null {
  useEffect(() => {
    if (state.kind === 'closed') return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.kind, onClose]);

  if (state.kind === 'closed') return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => (state.kind !== 'newPlanForm' || !state.busy ? onClose() : undefined)}
    >
      <div
        className="modal-panel new-plan-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Test plan required"
        onClick={(e) => e.stopPropagation()}
        data-testid="plan-gate-dialog"
      >
        {state.kind === 'noPlan' ? (
          <NoPlanView state={state} onClose={onClose} onAdvance={onAdvanceFromNoPlan} />
        ) : null}
        {state.kind === 'newPlanForm' ? (
          <NewPlanFormView state={state} onClose={onClose} onSubmit={onGenerate} />
        ) : null}
        {state.kind === 'pick' ? (
          <PickView state={state} onClose={onClose} onPick={onPick} onAddNew={onAddNewFromPicker} />
        ) : null}
      </div>
    </div>
  );
}

function NoPlanView({
  state,
  onClose,
  onAdvance,
}: {
  state: Extract<PlanGateState, { kind: 'noPlan' }>;
  onClose: () => void;
  onAdvance: () => void;
}): ReactElement {
  return (
    <div>
      <div className="modal-title">{labelForAgent(state.agent.name)} needs a test plan</div>
      <div className="modal-body">
        QA agents only run against an explicit test plan so you always know exactly which test cases
        will be exercised. Generate one now — the plan is markdown in your repo at{' '}
        <span className="mono">qa/test-plans/</span>, and every case is editable.
      </div>
      {state.error ? (
        <div className="file-issue-error">
          <Icon.AlertTri size={11} /> {state.error}
        </div>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={onAdvance}
          data-testid="plan-gate-generate-cta"
        >
          <Icon.Plus size={12} /> Generate plan
        </button>
      </div>
    </div>
  );
}

function NewPlanFormView({
  state,
  onClose,
  onSubmit,
}: {
  state: Extract<PlanGateState, { kind: 'newPlanForm' }>;
  onClose: () => void;
  onSubmit: (input: { scope: TestPlanScope; featureName?: string }) => void;
}): ReactElement {
  const [scope, setScope] = useState<TestPlanScope>(state.scope);
  const [feature, setFeature] = useState(state.featureName);

  useEffect(() => {
    setScope(state.scope);
    setFeature(state.featureName);
  }, [state.scope, state.featureName]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (state.busy) return;
    if (scope === 'feature' && !feature.trim()) return;
    onSubmit({
      scope,
      ...(scope === 'feature' && feature.trim() ? { featureName: feature.trim() } : {}),
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-title">Generate test plan for {labelForAgent(state.agent.name)}</div>
      <div className="modal-body">
        We&rsquo;ll scan the repo and produce a structured plan. Each case is editable before the
        agent runs.
      </div>

      <div className="new-plan-field">
        <label className="new-plan-label">Scope</label>
        <div className="new-plan-segmented">
          <button
            type="button"
            className={`new-plan-seg${scope === 'whole-app' ? ' active' : ''}`}
            onClick={() => setScope('whole-app')}
            disabled={state.busy}
          >
            Whole app
          </button>
          <button
            type="button"
            className={`new-plan-seg${scope === 'feature' ? ' active' : ''}`}
            onClick={() => setScope('feature')}
            disabled={state.busy}
          >
            Specific feature
          </button>
        </div>
      </div>

      {scope === 'feature' ? (
        <div className="new-plan-field">
          <label className="new-plan-label" htmlFor="plan-gate-feature">
            Feature name
          </label>
          <input
            id="plan-gate-feature"
            className="file-issue-input"
            type="text"
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
            placeholder="e.g. checkout, sign-in, settings"
            disabled={state.busy}
            autoFocus
          />
        </div>
      ) : null}

      {state.error ? (
        <div className="file-issue-error">
          <Icon.AlertTri size={11} /> {state.error}
        </div>
      ) : null}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={state.busy}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={state.busy || (scope === 'feature' && !feature.trim())}
          data-testid="plan-gate-submit"
        >
          {state.busy ? (
            <>
              <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
              Generating…
            </>
          ) : (
            <>Generate plan</>
          )}
        </button>
      </div>
    </form>
  );
}

function PickView({
  state,
  onClose,
  onPick,
  onAddNew,
}: {
  state: Extract<PlanGateState, { kind: 'pick' }>;
  onClose: () => void;
  onPick: (planId: string) => void;
  onAddNew: () => void;
}): ReactElement {
  return (
    <div>
      <div className="modal-title">Pick a test plan</div>
      <div className="modal-body">
        {labelForAgent(state.agent.name)} will run against the plan you choose.
      </div>
      <div className="plan-picker-list">
        {state.plans.map((p) => (
          <button
            key={p.id}
            type="button"
            className="plan-picker-row"
            onClick={() => onPick(p.id)}
            data-testid={`plan-picker-${p.id}`}
          >
            <div>
              <div className="plan-picker-row-title">{p.name}</div>
              <div className="plan-picker-row-sub">
                {p.scope === 'feature' ? `feature · ${p.feature}` : 'whole app'} · {p.caseCount}{' '}
                case{p.caseCount === 1 ? '' : 's'} · edited {shortDate(p.updatedAt)}
              </div>
            </div>
            <Icon.Play size={12} color="var(--brand)" />
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onAddNew}>
          <Icon.Plus size={12} /> New plan
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Used by Home to compute the right initial state once a list loads. */
export function gateStateFor(opts: { agent: Agent; plans: TestPlanSummary[] }): PlanGateState {
  if (opts.plans.length === 0) {
    return { kind: 'noPlan', agent: opts.agent, busy: false, error: null };
  }
  if (opts.plans.length === 1) {
    return { kind: 'closed' };
  }
  return { kind: 'pick', agent: opts.agent, plans: opts.plans };
}

export const QA_AGENT_NAMES_FOR_GATE = new Set<AgentName>([
  'qa-hunter',
  'manual-qa',
  'ios-qa-pilot',
]);
