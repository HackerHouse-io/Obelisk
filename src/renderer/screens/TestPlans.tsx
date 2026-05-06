import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { ulid } from 'ulid';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { shortDate, labelForAgent } from '../format';
import type {
  AgentName,
  TestPlan,
  TestPlanBlock,
  TestPlanScope,
  TestPlanSummary,
} from '../../shared/types';

const QA_AGENT_NAMES: AgentName[] = ['qa-hunter', 'manual-qa', 'ios-qa-pilot'];

interface NewPlanState {
  open: boolean;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName: string;
  busy: boolean;
  error: string | null;
}

export function TestPlans(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const setRoute = useStore((s) => s.setRoute);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [plans, setPlans] = useState<TestPlanSummary[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<TestPlan | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TestPlanSummary | null>(null);
  const [newPlan, setNewPlan] = useState<NewPlanState>({
    open: false,
    agentName: 'qa-hunter',
    scope: 'whole-app',
    featureName: '',
    busy: false,
    error: null,
  });

  const refreshList = useCallback(async () => {
    if (!repo) return;
    const res = await window.obelisk.invoke('testPlans:list', { repoId: repo.id });
    if (res.ok) {
      setPlans(res.value);
      if (!activePlanId && res.value.length > 0) {
        setActivePlanId(res.value[0]!.id);
      }
    }
  }, [repo, activePlanId]);

  const loadPlan = useCallback(
    async (planId: string): Promise<void> => {
      if (!repo) return;
      const res = await window.obelisk.invoke('testPlans:get', { planId, repoId: repo.id });
      if (res.ok) setActivePlan(res.value);
    },
    [repo],
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!repo) return;
    return window.obelisk.subscribe((evt) => {
      if (evt.type === 'testPlans.changed' && evt.repoId === repo.id) {
        void refreshList();
        if (activePlanId) void loadPlan(activePlanId);
      }
    });
  }, [repo, refreshList, loadPlan, activePlanId]);

  useEffect(() => {
    if (activePlanId) void loadPlan(activePlanId);
  }, [activePlanId, loadPlan]);

  const saveBlocks = useCallback(
    async (blocks: TestPlanBlock[]): Promise<void> => {
      if (!repo || !activePlan) return;
      const res = await window.obelisk.invoke('testPlans:save', {
        planId: activePlan.frontmatter.id,
        repoId: repo.id,
        blocks,
      });
      if (res.ok) setSavedAt(res.value.savedAt);
    },
    [repo, activePlan],
  );

  const onChangeBlocks = useCallback(
    (blocks: TestPlanBlock[]) => {
      if (!activePlan) return;
      setActivePlan({ ...activePlan, blocks });
      void saveBlocks(blocks);
    },
    [activePlan, saveBlocks],
  );

  async function generatePlan(opts: {
    agentName: AgentName;
    scope: TestPlanScope;
    featureName?: string;
  }): Promise<void> {
    if (!repo) return;
    setNewPlan((s) => ({ ...s, busy: true, error: null }));
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId: repo.id,
      agentName: opts.agentName,
      scope: opts.scope,
      ...(opts.featureName ? { featureName: opts.featureName } : {}),
    });
    if (!res.ok) {
      setNewPlan((s) => ({ ...s, busy: false, error: res.error.message }));
      return;
    }
    setNewPlan({
      open: false,
      agentName: 'qa-hunter',
      scope: 'whole-app',
      featureName: '',
      busy: false,
      error: null,
    });
    setActivePlanId(res.value.planId);
    await refreshList();
  }

  async function runWithPlan(plan: TestPlan): Promise<void> {
    if (!repo) return;
    const agentsRes = await window.obelisk.invoke('agents:list', { repoId: repo.id });
    if (!agentsRes.ok) {
      alert(agentsRes.error.message);
      return;
    }
    const agent = agentsRes.value.find((a) => a.name === plan.frontmatter.agentName);
    if (!agent) {
      alert(`No ${labelForAgent(plan.frontmatter.agentName)} agent installed for this repo.`);
      return;
    }
    const res = await window.obelisk.invoke('agents:run', {
      agentId: agent.id,
      taskId: `plan:${plan.frontmatter.id}`,
    });
    if (!res.ok) {
      alert(`Could not start agent: ${res.error.message}`);
      return;
    }
    setRoute('mission');
  }

  async function deletePlan(planId: string): Promise<void> {
    if (!repo) return;
    const res = await window.obelisk.invoke('testPlans:delete', { planId, repoId: repo.id });
    if (!res.ok) {
      alert(res.error.message);
      return;
    }
    setConfirmDelete(null);
    if (activePlanId === planId) setActivePlanId(null);
    await refreshList();
  }

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Connect a GitHub repo to manage QA agent test plans."
      />
    );
  }

  return (
    <div className="test-plans">
      <aside className="test-plans-sidebar">
        <div className="test-plans-sidebar-title">
          <Icon.Doc size={13} color="var(--brand)" /> Test plans
        </div>
        <div className="test-plans-sidebar-sub">
          QA agents need a plan before they can run. One per agent or one per feature.
        </div>
        <div className="col gap-1" style={{ marginTop: 8 }}>
          {plans.length === 0 ? (
            <div className="test-plans-empty-list">No plans yet.</div>
          ) : (
            plans.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`test-plans-list-item${activePlanId === p.id ? ' active' : ''}`}
                onClick={() => setActivePlanId(p.id)}
                data-testid={`plan-item-${p.id}`}
              >
                <div className="test-plans-list-item-title">{p.name}</div>
                <div className="test-plans-list-item-sub">
                  {p.scope === 'feature' ? `feature · ${p.feature}` : 'whole app'} ·{' '}
                  {labelForAgent(p.agentName)} · {p.caseCount} case{p.caseCount === 1 ? '' : 's'}
                </div>
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          className="btn primary sm test-plans-new"
          onClick={() => setNewPlan((s) => ({ ...s, open: true, error: null }))}
          data-testid="plan-new-button"
        >
          <Icon.Plus size={11} /> New plan
        </button>
      </aside>

      <div className="test-plans-main">
        {activePlan ? (
          <PlanEditor
            plan={activePlan}
            savedAt={savedAt}
            onChange={onChangeBlocks}
            onRun={() => void runWithPlan(activePlan)}
            onDelete={() => {
              const summary = plans.find((p) => p.id === activePlan.frontmatter.id);
              if (summary) setConfirmDelete(summary);
            }}
          />
        ) : (
          <EmptyState
            title="Pick a plan"
            body="Select a plan from the sidebar, or generate a new one."
            action={{
              label: 'New plan',
              icon: <Icon.Plus size={13} />,
              onClick: () => setNewPlan((s) => ({ ...s, open: true })),
            }}
          />
        )}
      </div>

      <NewPlanDialog
        state={newPlan}
        onClose={() =>
          setNewPlan({
            open: false,
            agentName: 'qa-hunter',
            scope: 'whole-app',
            featureName: '',
            busy: false,
            error: null,
          })
        }
        onChange={(patch) => setNewPlan((s) => ({ ...s, ...patch }))}
        onSubmit={() =>
          void generatePlan({
            agentName: newPlan.agentName,
            scope: newPlan.scope,
            ...(newPlan.scope === 'feature' && newPlan.featureName.trim()
              ? { featureName: newPlan.featureName.trim() }
              : {}),
          })
        }
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : ''}
        body="Removes the plan markdown from your repo. The agent's previous findings stay in place."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void deletePlan(confirmDelete.id);
        }}
      />
    </div>
  );
}

/* ---------- Plan editor (Notion-like) ---------- */

function PlanEditor({
  plan,
  savedAt,
  onChange,
  onRun,
  onDelete,
}: {
  plan: TestPlan;
  savedAt: string | null;
  onChange: (blocks: TestPlanBlock[]) => void;
  onRun: () => void;
  onDelete: () => void;
}): ReactElement {
  const blocks = plan.blocks;

  function patch(idx: number, next: Partial<TestPlanBlock>): void {
    const copy = blocks.slice();
    const cur = copy[idx];
    if (!cur) return;
    copy[idx] = { ...cur, ...next } as TestPlanBlock;
    onChange(copy);
  }

  function removeAt(idx: number): void {
    const copy = blocks.slice();
    copy.splice(idx, 1);
    // Drop the section if it has no following cases? Keep it — sections can be empty.
    onChange(copy);
  }

  function insertAfter(idx: number, block: TestPlanBlock): void {
    const copy = blocks.slice();
    copy.splice(idx + 1, 0, block);
    onChange(copy);
  }

  function appendBlock(block: TestPlanBlock): void {
    onChange([...blocks, block]);
  }

  function moveBlock(idx: number, dir: -1 | 1): void {
    const target = idx + dir;
    if (target < 0 || target >= blocks.length) return;
    const copy = blocks.slice();
    const [removed] = copy.splice(idx, 1);
    if (removed) copy.splice(target, 0, removed);
    onChange(copy);
  }

  // For "+ Add test case" buttons under a section — find the section's range.
  function indexOfSectionEnd(sectionIdx: number): number {
    for (let i = sectionIdx + 1; i < blocks.length; i++) {
      if (blocks[i]!.kind === 'section') return i - 1;
    }
    return blocks.length - 1;
  }

  return (
    <div className="plan-editor">
      <header className="plan-editor-header">
        <div>
          <div className="plan-editor-title">{plan.frontmatter.name}</div>
          <div className="plan-editor-sub">
            {plan.frontmatter.scope === 'feature'
              ? `feature · ${plan.frontmatter.feature}`
              : 'whole app'}{' '}
            · {labelForAgent(plan.frontmatter.agentName)} · {plan.caseCount} case
            {plan.caseCount === 1 ? '' : 's'} ·{' '}
            {savedAt ? `saved ${shortDate(savedAt)}` : `edited ${shortDate(plan.updatedAt)}`}
          </div>
        </div>
        <div className="row gap-2">
          <button
            type="button"
            className="btn ghost sm"
            onClick={onDelete}
            title="Delete this plan"
          >
            <Icon.Trash size={11} /> Delete
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={onRun}
            data-testid="plan-run-button"
            title={`Run ${labelForAgent(plan.frontmatter.agentName)} against this plan`}
          >
            <Icon.Play size={11} /> Run {labelForAgent(plan.frontmatter.agentName)}
          </button>
        </div>
      </header>

      <div className="plan-editor-body">
        {blocks.length === 0 ? (
          <button
            type="button"
            className="plan-add-block"
            onClick={() => appendBlock(makeSection('New section'))}
          >
            <Icon.Plus size={11} /> Add section
          </button>
        ) : null}
        {blocks.map((b, idx) => {
          if (b.kind === 'section') {
            return (
              <SectionRow
                key={b.id}
                block={b}
                onTitleChange={(title) => patch(idx, { title })}
                onAddCase={() => insertAfter(indexOfSectionEnd(idx), makeCase())}
                onDelete={() => removeAt(idx)}
                onMoveUp={() => moveBlock(idx, -1)}
                onMoveDown={() => moveBlock(idx, 1)}
              />
            );
          }
          return (
            <CaseRow
              key={b.id}
              block={b}
              onChange={(next) => patch(idx, next)}
              onDelete={() => removeAt(idx)}
              onMoveUp={() => moveBlock(idx, -1)}
              onMoveDown={() => moveBlock(idx, 1)}
            />
          );
        })}
        {blocks.length > 0 ? (
          <div className="row gap-2 plan-add-bottom">
            <button
              type="button"
              className="plan-add-block"
              onClick={() => appendBlock(makeSection('New section'))}
            >
              <Icon.Plus size={11} /> Add section
            </button>
            <button
              type="button"
              className="plan-add-block"
              onClick={() => appendBlock(makeCase())}
            >
              <Icon.Plus size={11} /> Add test case
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SectionRow({
  block,
  onTitleChange,
  onAddCase,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  block: Extract<TestPlanBlock, { kind: 'section' }>;
  onTitleChange: (title: string) => void;
  onAddCase: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}): ReactElement {
  return (
    <div className="plan-section">
      <div className="plan-section-head">
        <EditableText
          className="plan-section-title"
          value={block.title}
          placeholder="Section name"
          onCommit={onTitleChange}
        />
        <div className="plan-block-actions">
          <button type="button" className="btn ghost icon" onClick={onMoveUp} title="Move up">
            <Icon.ChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button type="button" className="btn ghost icon" onClick={onMoveDown} title="Move down">
            <Icon.ChevronDown size={11} />
          </button>
          <button
            type="button"
            className="btn ghost icon"
            onClick={onDelete}
            title="Delete section"
          >
            <Icon.Trash size={11} />
          </button>
        </div>
      </div>
      <button type="button" className="plan-add-block plan-add-case" onClick={onAddCase}>
        <Icon.Plus size={11} /> Add test case
      </button>
    </div>
  );
}

function CaseRow({
  block,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  block: Extract<TestPlanBlock, { kind: 'case' }>;
  onChange: (next: Partial<TestPlanBlock>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}): ReactElement {
  return (
    <div className="plan-case">
      <div className="plan-case-head">
        <span
          className="plan-case-checkbox"
          aria-hidden="true"
          title="Visual indicator only — pass/fail comes from agent runs"
        />
        <EditableText
          className="plan-case-title"
          value={block.title}
          placeholder="Test case title"
          onCommit={(title) => onChange({ title })}
        />
        <SeveritySelect value={block.severity} onChange={(severity) => onChange({ severity })} />
        <div className="plan-block-actions">
          <button type="button" className="btn ghost icon" onClick={onMoveUp} title="Move up">
            <Icon.ChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button type="button" className="btn ghost icon" onClick={onMoveDown} title="Move down">
            <Icon.ChevronDown size={11} />
          </button>
          <button type="button" className="btn ghost icon" onClick={onDelete} title="Delete case">
            <Icon.Trash size={11} />
          </button>
        </div>
      </div>
      <div className="plan-case-meta">
        <label className="plan-case-meta-row">
          <span className="plan-case-meta-key">Expected</span>
          <EditableText
            className="plan-case-meta-value"
            value={block.expected ?? ''}
            placeholder="The success contract for this case"
            onCommit={(v) => onChange({ expected: v.trim() ? v : null })}
          />
        </label>
        <label className="plan-case-meta-row">
          <span className="plan-case-meta-key">Repro</span>
          <EditableText
            className="plan-case-meta-value"
            value={block.repro ?? ''}
            placeholder="Steps the agent should follow to exercise this case"
            onCommit={(v) => onChange({ repro: v.trim() ? v : null })}
          />
        </label>
      </div>
    </div>
  );
}

function SeveritySelect({
  value,
  onChange,
}: {
  value: 'P0' | 'P1' | 'P2' | null;
  onChange: (next: 'P0' | 'P1' | 'P2' | null) => void;
}): ReactElement {
  return (
    <select
      className="plan-severity-select"
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? null : (v as 'P0' | 'P1' | 'P2'));
      }}
      title="Severity"
    >
      <option value="">—</option>
      <option value="P0">P0</option>
      <option value="P1">P1</option>
      <option value="P2">P2</option>
    </select>
  );
}

function EditableText({
  className,
  value,
  placeholder,
  onCommit,
}: {
  className: string;
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement | null>(null);

  // Keep local draft in sync when the underlying value changes externally.
  useEffect(() => {
    setDraft(value);
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  function handleBlur(): void {
    const next = (ref.current?.textContent ?? '').trim();
    if (next !== value.trim()) onCommit(next);
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ref.current?.blur();
    }
  }

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className={`${className}${draft.trim() === '' ? ' is-empty' : ''}`}
      data-placeholder={placeholder}
      onInput={(e) => setDraft((e.target as HTMLDivElement).textContent ?? '')}
      onBlur={handleBlur}
      onKeyDown={handleKey}
      role="textbox"
      tabIndex={0}
    >
      {value}
    </div>
  );
}

/* ---------- New-plan dialog ---------- */

function NewPlanDialog({
  state,
  onClose,
  onChange,
  onSubmit,
}: {
  state: NewPlanState;
  onClose: () => void;
  onChange: (patch: Partial<NewPlanState>) => void;
  onSubmit: () => void;
}): ReactElement | null {
  if (!state.open) return null;
  return (
    <div className="modal-overlay" onClick={() => !state.busy && onClose()}>
      <div
        className="modal-panel new-plan-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Generate test plan"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (state.busy) return;
            if (state.scope === 'feature' && !state.featureName.trim()) return;
            onSubmit();
          }}
        >
          <div className="modal-title">Generate test plan</div>
          <div className="modal-body">
            We&rsquo;ll scan the repo to draft a plan you can review before the agent runs. Every
            case is editable.
          </div>

          <div className="new-plan-field">
            <label className="new-plan-label">Agent</label>
            <div className="new-plan-segmented">
              {QA_AGENT_NAMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`new-plan-seg${state.agentName === n ? ' active' : ''}`}
                  onClick={() => onChange({ agentName: n })}
                >
                  {labelForAgent(n)}
                </button>
              ))}
            </div>
          </div>

          <div className="new-plan-field">
            <label className="new-plan-label">Scope</label>
            <div className="new-plan-segmented">
              <button
                type="button"
                className={`new-plan-seg${state.scope === 'whole-app' ? ' active' : ''}`}
                onClick={() => onChange({ scope: 'whole-app' })}
              >
                Whole app
              </button>
              <button
                type="button"
                className={`new-plan-seg${state.scope === 'feature' ? ' active' : ''}`}
                onClick={() => onChange({ scope: 'feature' })}
              >
                Specific feature
              </button>
            </div>
          </div>

          {state.scope === 'feature' ? (
            <div className="new-plan-field">
              <label className="new-plan-label" htmlFor="feature-name-input">
                Feature name
              </label>
              <input
                id="feature-name-input"
                className="file-issue-input"
                type="text"
                value={state.featureName}
                onChange={(e) => onChange({ featureName: e.target.value })}
                placeholder="e.g. checkout, sign-in, settings"
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
              disabled={state.busy || (state.scope === 'feature' && !state.featureName.trim())}
              data-testid="plan-generate-submit"
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
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function makeSection(title: string): TestPlanBlock {
  return { kind: 'section', id: ulid(), title };
}

function makeCase(): TestPlanBlock {
  return {
    kind: 'case',
    id: ulid(),
    title: 'New test case',
    expected: null,
    repro: null,
    severity: null,
  };
}
