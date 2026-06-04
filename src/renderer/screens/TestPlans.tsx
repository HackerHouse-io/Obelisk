import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ulid } from 'ulid';
import { useStore } from '../state/store';
import { Icon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { showApiAlert } from '../state/alert-store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ModelSelect } from '../components/ModelSelect';
import { useClickOutside } from '../hooks/useClickOutside';
import { shortDate, labelForAgent } from '../format';
import type {
  AgentName,
  FindingSeverity,
  TestPlan,
  TestPlanBlock,
  TestPlanGenerationJob,
  TestPlanScope,
  TestPlanSummary,
} from '../../shared/types';

interface NewPlanState {
  open: boolean;
  agentName: AgentName;
  scope: TestPlanScope;
  featureName: string;
  /** '' means "use Settings default runner". */
  runnerOverride: '' | 'claude' | 'codex';
  /** '' means "use Settings default model" (no --model flag). */
  modelOverride: string;
  /** Coverage-aware focus: bias the AI toward uncovered/churned files. */
  focusOnChangedOrUncovered: boolean;
  busy: boolean;
  error: string | null;
}

const INITIAL_NEW_PLAN_STATE: NewPlanState = {
  open: false,
  agentName: 'qa-hunter',
  scope: 'whole-app',
  featureName: '',
  runnerOverride: '',
  modelOverride: '',
  focusOnChangedOrUncovered: false,
  busy: false,
  error: null,
};

function isJobActive(job: TestPlanGenerationJob): boolean {
  return job.stage !== 'done' && job.stage !== 'failed';
}

function featureKey(name: string): string {
  return name.trim().toLowerCase();
}

function buildInFlightFeatureSet(jobs: TestPlanGenerationJob[], repoId: string): Set<string> {
  const set = new Set<string>();
  for (const job of jobs) {
    if (job.repoId !== repoId) continue;
    if (job.scope !== 'feature') continue;
    if (!job.feature) continue;
    if (!isJobActive(job)) continue;
    set.add(featureKey(job.feature));
  }
  return set;
}

function applyJobToInFlightSet(prev: Set<string>, job: TestPlanGenerationJob): Set<string> {
  if (job.scope !== 'feature' || !job.feature) return prev;
  const key = featureKey(job.feature);
  const active = isJobActive(job);
  if (active && prev.has(key)) return prev;
  if (!active && !prev.has(key)) return prev;
  const next = new Set(prev);
  if (active) next.add(key);
  else next.delete(key);
  return next;
}

export function TestPlans(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const setRoute = useStore((s) => s.setRoute);
  const pendingPlanId = useStore((s) => s.pendingPlanId);
  const clearPendingPlan = useStore((s) => s.clearPendingPlan);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [plans, setPlans] = useState<TestPlanSummary[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<TestPlan | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TestPlanSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [newPlan, setNewPlan] = useState<NewPlanState>(INITIAL_NEW_PLAN_STATE);
  // Lowercased trimmed feature names with a non-terminal generation job for
  // the active repo. Drives the per-section "Generate" button's in-flight
  // disable state so the user can't double-fire a job for the same feature.
  const [featuresInFlight, setFeaturesInFlight] = useState<Set<string>>(() => new Set());
  // Coverage-map feature labels — offered as suggestions in the New plan
  // dialog so plans align with the radar's taxonomy instead of inventing
  // directory-bucket features. Fetched lazily when the dialog opens.
  const [mapFeatures, setMapFeatures] = useState<string[]>([]);
  useEffect(() => {
    if (!newPlan.open || !repo) return;
    void window.obelisk.invoke('coverage:list', { repoId: repo.id }).then((res) => {
      if (res.ok) setMapFeatures(res.value.features.map((f) => f.label));
    });
  }, [newPlan.open, repo]);

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

  // Deep-link from Coverage: open the requested plan, then clear the pending
  // selection so a later visit falls back to the default (first plan).
  useEffect(() => {
    if (!pendingPlanId) return;
    setActivePlanId(pendingPlanId);
    clearPendingPlan();
  }, [pendingPlanId, clearPendingPlan]);

  // The generation toast dispatches this event when the user clicks "Open"
  // on a finished job — focus the new plan in the editor.
  useEffect(() => {
    function onOpen(e: Event): void {
      const detail = (e as CustomEvent<{ planId: string }>).detail;
      if (detail?.planId) {
        setActivePlanId(detail.planId);
        void refreshList();
      }
    }
    window.addEventListener('obelisk:open-test-plan', onOpen);
    return () => window.removeEventListener('obelisk:open-test-plan', onOpen);
  }, [refreshList]);

  // Seed `featuresInFlight` from the current job list whenever the active
  // repo changes, and keep it in sync via the generation-progress bus. Keyed
  // by trimmed lowercased feature name so the per-section button can compare
  // against its current title without worrying about casing.
  useEffect(() => {
    if (!repo) {
      setFeaturesInFlight(new Set());
      return;
    }
    let cancelled = false;
    void window.obelisk.invoke('testPlans:generationJobs', { repoId: repo.id }).then((res) => {
      if (cancelled || !res.ok) return;
      setFeaturesInFlight(buildInFlightFeatureSet(res.value, repo.id));
    });
    const unsub = window.obelisk.subscribe((evt) => {
      if (evt.type !== 'testPlanGeneration.progress') return;
      if (evt.job.repoId !== repo.id) return;
      setFeaturesInFlight((prev) => applyJobToInFlightSet(prev, evt.job));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [repo]);

  const saveBlocks = useCallback(
    async (
      blocks: TestPlanBlock[],
      patch?: { name?: string; agentNames?: AgentName[] },
    ): Promise<void> => {
      if (!repo || !activePlan) return;
      const res = await window.obelisk.invoke('testPlans:save', {
        planId: activePlan.frontmatter.id,
        repoId: repo.id,
        blocks,
        ...(patch?.name ? { name: patch.name } : {}),
        ...(patch?.agentNames && patch.agentNames.length > 0
          ? { agentNames: patch.agentNames }
          : {}),
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

  const onRenamePlan = useCallback(
    (next: string) => {
      if (!activePlan) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === activePlan.frontmatter.name) return;
      setActivePlan({
        ...activePlan,
        frontmatter: { ...activePlan.frontmatter, name: trimmed },
      });
      void saveBlocks(activePlan.blocks, { name: trimmed });
    },
    [activePlan, saveBlocks],
  );

  const onChangeAgents = useCallback(
    (next: AgentName[]) => {
      if (!activePlan) return;
      const dedup = Array.from(new Set(next));
      if (dedup.length === 0) return;
      const current = activePlan.frontmatter.agentNames;
      const same = current.length === dedup.length && current.every((a, i) => a === dedup[i]);
      if (same) return;
      setActivePlan({
        ...activePlan,
        frontmatter: { ...activePlan.frontmatter, agentNames: dedup },
      });
      void saveBlocks(activePlan.blocks, { agentNames: dedup });
    },
    [activePlan, saveBlocks],
  );

  async function generatePlan(opts: {
    agentName: AgentName;
    scope: TestPlanScope;
    featureName?: string;
    runnerOverride?: 'claude' | 'codex';
    modelOverride?: string;
    focusOnChangedOrUncovered?: boolean;
  }): Promise<void> {
    if (!repo) return;
    setNewPlan((s) => ({ ...s, busy: true, error: null }));
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId: repo.id,
      agentName: opts.agentName,
      scope: opts.scope,
      ...(opts.featureName ? { featureName: opts.featureName } : {}),
      ...(opts.runnerOverride ? { runnerOverride: opts.runnerOverride } : {}),
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.focusOnChangedOrUncovered ? { focusOnChangedOrUncovered: true } : {}),
    });
    if (!res.ok) {
      setNewPlan((s) => ({ ...s, busy: false, error: res.error.message }));
      return;
    }
    // The IPC returns immediately with a jobId; the actual generation runs
    // in the background and the floating toast streams its progress. Close
    // the modal so the user can keep working.
    setNewPlan(INITIAL_NEW_PLAN_STATE);
  }

  async function generateForFeature(
    featureName: string,
    overrides: { runnerOverride?: 'claude' | 'codex'; modelOverride?: string },
  ): Promise<void> {
    if (!repo || !activePlan) return;
    const agentName = activePlan.frontmatter.agentNames[0] ?? 'qa-hunter';
    const res = await window.obelisk.invoke('testPlans:generate', {
      repoId: repo.id,
      agentName,
      scope: 'feature',
      featureName,
      ...(overrides.runnerOverride ? { runnerOverride: overrides.runnerOverride } : {}),
      ...(overrides.modelOverride !== undefined ? { modelOverride: overrides.modelOverride } : {}),
    });
    if (!res.ok) {
      // Synchronous failures here are rare — bad input would already have
      // disabled the button. Surface anything that does slip through via the
      // editor's existing error banner instead of swallowing it silently.
      setRunError(`Could not start generation: ${res.error.message}`);
      return;
    }
    // Optimistically mark this feature in-flight so a fast second click is
    // ignored before the progress bus has caught up.
    setFeaturesInFlight((prev) => {
      const key = featureKey(featureName);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  async function runWithPlan(
    plan: TestPlan,
    targetAgent: AgentName,
    overrides?: { runnerOverride?: 'claude' | 'codex'; modelOverride?: string },
  ): Promise<void> {
    if (!repo || runStarting) return;
    setRunError(null);
    setRunStarting(true);
    try {
      const agentsRes = await window.obelisk.invoke('agents:list', { repoId: repo.id });
      if (!agentsRes.ok) {
        setRunError(agentsRes.error.message);
        setRunStarting(false);
        return;
      }
      const agent = agentsRes.value.find((a) => a.name === targetAgent);
      if (!agent) {
        setRunError(`No ${labelForAgent(targetAgent)} agent installed for this repo.`);
        setRunStarting(false);
        return;
      }
      const res = await window.obelisk.invoke('agents:run', {
        agentId: agent.id,
        taskId: `plan:${plan.frontmatter.id}`,
        ...(overrides?.runnerOverride ? { runnerOverride: overrides.runnerOverride } : {}),
        ...(overrides?.modelOverride !== undefined
          ? { modelOverride: overrides.modelOverride }
          : {}),
      });
      if (!res.ok) {
        setRunError(`${res.error.message}${res.error.hint ? ` — ${res.error.hint}` : ''}`);
        setRunStarting(false);
        return;
      }
      window.dispatchEvent(
        new CustomEvent('obelisk:run-started', {
          detail: {
            runId: res.value.runId,
            agentName: targetAgent,
            planName: plan.frontmatter.name,
            caseCount: plan.caseCount,
          },
        }),
      );
      setRoute('mission');
      // Component unmounts on route change; no need to clear runStarting.
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start the run.');
      setRunStarting(false);
    }
  }

  async function deletePlan(planId: string): Promise<void> {
    if (!repo) return;
    const res = await window.obelisk.invoke('testPlans:delete', { planId, repoId: repo.id });
    if (!res.ok) {
      showApiAlert(res.error, 'delete plan');
      return;
    }
    setConfirmDelete(null);
    if (activePlanId === planId) setActivePlanId(null);
    await refreshList();
  }

  function scrollToSection(sectionId: string): void {
    const el = document.querySelector<HTMLElement>(`[data-section-id="${sectionId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        <button
          type="button"
          className="btn ghost sm test-plans-back"
          onClick={() => setRoute('coverage')}
          title="Back to Coverage"
          data-testid="test-plans-back"
        >
          <Icon.ArrowLeft size={12} /> Coverage
        </button>
        <div className="test-plans-sidebar-header">
          <Icon.Playbook size={13} color="var(--brand)" />
          <span>Test plans</span>
        </div>
        <div className="test-plans-sidebar-sub">
          QA agents need a plan to run. Each plan lists the test cases the agent will execute.
        </div>

        {plans.length === 0 ? (
          <div className="test-plans-empty-list">
            No plans yet. Click <em>+ New plan</em> to draft one.
          </div>
        ) : (
          <div className="test-plans-toc">
            {plans.map((p) => (
              <PlanTocEntry
                key={p.id}
                summary={p}
                active={activePlanId === p.id}
                expanded={activePlanId === p.id}
                sections={
                  activePlanId === p.id && activePlan
                    ? activePlan.blocks
                        .filter((b) => b.kind === 'section')
                        .map((b) => ({ id: b.id, title: (b as { title: string }).title }))
                    : []
                }
                onSelect={() => setActivePlanId(p.id)}
                onJumpSection={(sid) => scrollToSection(sid)}
              />
            ))}
          </div>
        )}

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
            runError={runError}
            runStarting={runStarting}
            featuresInFlight={featuresInFlight}
            onChange={onChangeBlocks}
            onRename={onRenamePlan}
            onChangeAgents={onChangeAgents}
            onRun={(targetAgent, overrides) => void runWithPlan(activePlan, targetAgent, overrides)}
            onGenerateFeature={generateForFeature}
            onDismissRunError={() => setRunError(null)}
            onDelete={() => {
              const summary = plans.find((p) => p.id === activePlan.frontmatter.id);
              if (summary) setConfirmDelete(summary);
            }}
          />
        ) : (
          <PlansEmptyState onNew={() => setNewPlan((s) => ({ ...s, open: true, error: null }))} />
        )}
      </div>

      <NewPlanDialog
        state={newPlan}
        mapFeatures={mapFeatures}
        onClose={() => setNewPlan(INITIAL_NEW_PLAN_STATE)}
        onChange={(patch) => setNewPlan((s) => ({ ...s, ...patch }))}
        onSubmit={() =>
          void generatePlan({
            agentName: newPlan.agentName,
            scope: newPlan.scope,
            ...(newPlan.scope === 'feature' && newPlan.featureName.trim()
              ? { featureName: newPlan.featureName.trim() }
              : {}),
            ...(newPlan.runnerOverride ? { runnerOverride: newPlan.runnerOverride } : {}),
            ...(newPlan.modelOverride.trim()
              ? { modelOverride: newPlan.modelOverride.trim() }
              : {}),
            ...(newPlan.focusOnChangedOrUncovered ? { focusOnChangedOrUncovered: true } : {}),
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

function PlanTocEntry({
  summary,
  active,
  expanded,
  sections,
  onSelect,
  onJumpSection,
}: {
  summary: TestPlanSummary;
  active: boolean;
  expanded: boolean;
  sections: { id: string; title: string }[];
  onSelect: () => void;
  onJumpSection: (id: string) => void;
}): ReactElement {
  return (
    <div className="test-plans-toc-entry">
      <button
        type="button"
        className={`test-plans-list-item${active ? ' active' : ''}`}
        onClick={onSelect}
        data-testid={`plan-item-${summary.id}`}
      >
        <div className="test-plans-list-item-title">{summary.name}</div>
        <div className="test-plans-list-item-sub">
          {summary.scope === 'feature' ? `feature · ${summary.feature}` : 'whole app'} ·{' '}
          {summary.caseCount} case{summary.caseCount === 1 ? '' : 's'}
        </div>
      </button>
      {expanded && sections.length > 0 ? (
        <div className="test-plans-toc-sections">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="test-plans-toc-section"
              onClick={() => onJumpSection(s.id)}
              title={`Jump to ${s.title}`}
            >
              {s.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlansEmptyState({ onNew }: { onNew: () => void }): ReactElement {
  return (
    <div className="plans-empty-state">
      <div className="plans-empty-icon">
        <Icon.Playbook size={28} color="var(--brand)" />
      </div>
      <div className="plans-empty-title">Draft a test plan to start</div>
      <div className="plans-empty-body">
        Test plans tell QA agents exactly what to check. Pick a scope below — every case is editable
        before the agent runs, and findings come back as previewable GitHub issues.
      </div>
      <button
        type="button"
        className="btn primary plans-empty-cta"
        onClick={onNew}
        data-testid="plan-empty-cta"
      >
        <Icon.Plus size={13} /> Draft a plan
      </button>
    </div>
  );
}

/* ---------- Plan editor (Notion-like) ---------- */

function PlanEditor({
  plan,
  savedAt,
  runError,
  runStarting,
  featuresInFlight,
  onChange,
  onRename,
  onChangeAgents,
  onRun,
  onGenerateFeature,
  onDismissRunError,
  onDelete,
}: {
  plan: TestPlan;
  savedAt: string | null;
  runError: string | null;
  runStarting: boolean;
  featuresInFlight: Set<string>;
  onChange: (blocks: TestPlanBlock[]) => void;
  onRename: (next: string) => void;
  onChangeAgents: (next: AgentName[]) => void;
  onRun: (
    targetAgent: AgentName,
    overrides?: { runnerOverride?: 'claude' | 'codex'; modelOverride?: string },
  ) => void;
  onGenerateFeature: (
    featureName: string,
    overrides: { runnerOverride?: 'claude' | 'codex'; modelOverride?: string },
  ) => Promise<void>;
  onDismissRunError: () => void;
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

  function indexOfSectionEnd(sectionIdx: number): number {
    for (let i = sectionIdx + 1; i < blocks.length; i++) {
      if (blocks[i]!.kind === 'section') return i - 1;
    }
    return blocks.length - 1;
  }

  // Walk blocks once, partitioning into [section, ...cases] groups for clean rendering.
  const groups: {
    section: { id: string; title: string; idx: number } | null;
    cases: { block: Extract<TestPlanBlock, { kind: 'case' }>; idx: number }[];
  }[] = [];
  let current: (typeof groups)[number] | null = null;
  blocks.forEach((b, idx) => {
    if (b.kind === 'section') {
      current = { section: { id: b.id, title: b.title, idx }, cases: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { section: null, cases: [] };
        groups.push(current);
      }
      current.cases.push({ block: b, idx });
    }
  });

  const isHeuristic = plan.frontmatter.generatedBy === 'heuristic';

  return (
    <div className="plan-editor">
      <header className="plan-editor-header">
        <div className="plan-editor-meta">
          <PlanTitleEditable value={plan.frontmatter.name} onCommit={onRename} />
          <div className="plan-editor-sub">
            {plan.frontmatter.scope === 'feature'
              ? `feature · ${plan.frontmatter.feature}`
              : 'whole app'}
            <span className="plan-editor-sep">·</span>
            <AgentMultiSelect value={plan.frontmatter.agentNames} onChange={onChangeAgents} />
            <span className="plan-editor-sep">·</span>
            {plan.caseCount} case{plan.caseCount === 1 ? '' : 's'}
            <span className="plan-editor-sep">·</span>
            {savedAt ? `saved ${shortDate(savedAt)}` : `edited ${shortDate(plan.updatedAt)}`}
          </div>
        </div>
        <div className="row gap-2 plan-editor-actions">
          <button
            type="button"
            className="btn ghost plan-editor-delete"
            onClick={onDelete}
            title="Delete this plan"
            aria-label="Delete this plan"
          >
            <Icon.Trash size={14} />
          </button>
          <RunButtonWithOptions
            agents={plan.frontmatter.agentNames}
            caseCount={plan.caseCount}
            runStarting={runStarting}
            onRun={onRun}
          />
        </div>
      </header>

      {runError ? (
        <div className="plan-editor-banner plan-editor-banner-error">
          <Icon.AlertTri size={12} />
          <div>
            <div className="plan-editor-banner-title">Could not start the run</div>
            <div className="plan-editor-banner-body">{runError}</div>
          </div>
          <button
            type="button"
            className="btn ghost icon"
            onClick={onDismissRunError}
            aria-label="Dismiss"
          >
            <Icon.Close size={11} />
          </button>
        </div>
      ) : null}

      {isHeuristic ? (
        <div className="plan-editor-banner plan-editor-banner-info">
          <Icon.Sparkles size={12} />
          <div>
            <div className="plan-editor-banner-title">Starter plan — please refine</div>
            <div className="plan-editor-banner-body">
              We drafted this from your repo&rsquo;s file layout. Replace the generic cases below
              with what your app actually does. The agent only checks what the plan says.
            </div>
          </div>
        </div>
      ) : null}

      <div className="plan-editor-body">
        {groups.length === 0 ? (
          <button
            type="button"
            className="plan-add-block plan-add-bottom"
            onClick={() => appendBlock(makeSection('New section'))}
          >
            <Icon.Plus size={11} /> Add section
          </button>
        ) : null}

        {groups.map((group) => (
          <div
            className="plan-group"
            key={group.section?.id ?? `unsec-${group.cases[0]?.block.id ?? 'x'}`}
          >
            {group.section ? (
              <SectionHeader
                block={{
                  kind: 'section' as const,
                  id: group.section.id,
                  title: group.section.title,
                }}
                count={group.cases.length}
                onTitleChange={(title) => patch(group.section!.idx, { title })}
                onAddCase={() => insertAfter(indexOfSectionEnd(group.section!.idx), makeCase())}
                onDelete={() => removeAt(group.section!.idx)}
                onMoveUp={() => moveBlock(group.section!.idx, -1)}
                onMoveDown={() => moveBlock(group.section!.idx, 1)}
                generateSlot={
                  plan.frontmatter.scope === 'whole-app' ? (
                    <GenerateFeatureButton
                      featureName={group.section.title}
                      inFlight={featuresInFlight.has(group.section.title.trim().toLowerCase())}
                      onGenerate={(overrides) =>
                        onGenerateFeature(group.section!.title.trim(), overrides)
                      }
                    />
                  ) : undefined
                }
              />
            ) : null}
            {group.cases.map(({ block, idx }) => (
              <CaseRow
                key={block.id}
                block={block}
                onChange={(next) => patch(idx, next)}
                onDelete={() => removeAt(idx)}
                onMoveUp={() => moveBlock(idx, -1)}
                onMoveDown={() => moveBlock(idx, 1)}
              />
            ))}
            {group.section ? (
              <button
                type="button"
                className="plan-add-block plan-add-case"
                onClick={() => insertAfter(indexOfSectionEnd(group.section!.idx), makeCase())}
              >
                <Icon.Plus size={11} /> Add test case
              </button>
            ) : null}
          </div>
        ))}

        {groups.length > 0 ? (
          <div className="row gap-2 plan-add-bottom">
            <button
              type="button"
              className="plan-add-block"
              onClick={() => appendBlock(makeSection('New section'))}
            >
              <Icon.Plus size={11} /> Add section
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunButtonWithOptions({
  agents,
  caseCount,
  runStarting,
  onRun,
}: {
  agents: AgentName[];
  caseCount: number;
  runStarting: boolean;
  onRun: (
    targetAgent: AgentName,
    overrides?: { runnerOverride?: 'claude' | 'codex'; modelOverride?: string },
  ) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [runner, setRunner] = useState<'' | 'claude' | 'codex'>('');
  const [model, setModel] = useState<string>('');
  const [target, setTarget] = useState<AgentName>(agents[0] ?? 'qa-hunter');
  // Keep `target` in sync with the plan's agent list — if the user removes
  // the currently-selected agent from the chips, fall back to the first one.
  useEffect(() => {
    if (!agents.includes(target)) {
      setTarget(agents[0] ?? 'qa-hunter');
    }
  }, [agents, target]);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(open, wrapRef, () => setOpen(false));

  const agentLabel = labelForAgent(target);

  function start(): void {
    setOpen(false);
    onRun(target, {
      ...(runner ? { runnerOverride: runner } : {}),
      ...(model.trim() ? { modelOverride: model.trim() } : {}),
    });
  }

  return (
    <div ref={wrapRef} className="plan-editor-run-wrap">
      <button
        type="button"
        className={`btn primary plan-editor-run${runStarting ? ' is-starting' : ''}`}
        onClick={() => {
          if (runStarting) return;
          setOpen((v) => !v);
        }}
        disabled={runStarting}
        aria-busy={runStarting}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="plan-run-button"
        title={
          runStarting
            ? `Starting ${agentLabel}…`
            : `Choose a model and run ${agentLabel} against this plan`
        }
      >
        {runStarting ? (
          <>
            <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
            <span>Starting {agentLabel}…</span>
          </>
        ) : (
          <>
            <Icon.Play size={12} />
            <span>
              Run {agentLabel}
              <span className="plan-editor-run-count">
                {' · '}
                {caseCount} case{caseCount === 1 ? '' : 's'}
              </span>
            </span>
          </>
        )}
      </button>

      {open && !runStarting ? (
        <div className="plan-run-popover" role="dialog" aria-label="Run options">
          <div className="plan-run-popover-title">Run {agentLabel}</div>
          <div className="plan-run-popover-sub">
            {agents.length > 1
              ? 'Pick which agent runs this plan, and the model for the run.'
              : "Pick the model for this run. Doesn't change the agent's default."}
          </div>
          {agents.length > 1 ? (
            <div className="plan-run-popover-field">
              <label className="new-plan-label" htmlFor="plan-run-target">
                Agent
              </label>
              <select
                id="plan-run-target"
                className="file-issue-input"
                value={target}
                onChange={(e) => setTarget(e.target.value as AgentName)}
                data-testid="plan-run-target"
              >
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {labelForAgent(a)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="plan-run-popover-field">
            <label className="new-plan-label" htmlFor="plan-run-runner">
              Runner
            </label>
            <select
              id="plan-run-runner"
              className="file-issue-input"
              value={runner}
              onChange={(e) => {
                const next = e.target.value as '' | 'claude' | 'codex';
                setRunner(next);
                // Model id namespace differs between Claude and Codex; reset
                // when the runner flips so we don't pass a Claude id to Codex.
                setModel('');
              }}
            >
              <option value="">Use default</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="plan-run-popover-field">
            <label className="new-plan-label" htmlFor="plan-run-model">
              Model
            </label>
            <ModelSelect id="plan-run-model" runner={runner} value={model} onChange={setModel} />
          </div>
          <div className="plan-run-popover-actions">
            <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={start}
              data-testid="plan-run-start"
            >
              <Icon.Play size={11} /> Start run
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface RunnerInstalledState {
  claude: { installed: boolean; version?: string; hint?: string };
  codex: { installed: boolean; version?: string; hint?: string };
}

/**
 * One-click "generate test map for this feature" button rendered inside a
 * section header on a whole-app plan. Opens a tiny popover (Runner +
 * Model), pre-flights that the chosen runner is on PATH, then dispatches
 * `testPlans:generate` with `scope: 'feature'`. The resulting feature-scoped
 * plan appears in the sidebar; the source plan is left untouched.
 */
function GenerateFeatureButton({
  featureName,
  inFlight,
  onGenerate,
}: {
  featureName: string;
  inFlight: boolean;
  onGenerate: (overrides: {
    runnerOverride?: 'claude' | 'codex';
    modelOverride?: string;
  }) => Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [runner, setRunner] = useState<'' | 'claude' | 'codex'>('');
  const [model, setModel] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [installed, setInstalled] = useState<RunnerInstalledState | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(open, wrapRef, () => setOpen(false));

  // Pre-flight on open: ask main which CLIs are installed so the Generate
  // button can disable itself before we dispatch a doomed job.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.obelisk.invoke('runners:installed', {}).then((res) => {
      if (cancelled) return;
      if (res.ok) setInstalled(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const trimmedName = featureName.trim();
  const disableReason = useMemo<string | null>(() => {
    if (trimmedName.length === 0) return 'Name the section first.';
    if (inFlight) return 'Already generating for this feature.';
    if (!installed) return null; // still probing — Generate stays disabled implicitly below
    if (runner === 'claude' && !installed.claude.installed) {
      return installed.claude.hint ?? 'Claude Code CLI not found on PATH.';
    }
    if (runner === 'codex' && !installed.codex.installed) {
      return installed.codex.hint ?? 'Codex CLI not found on PATH.';
    }
    if (runner === '' && !installed.claude.installed && !installed.codex.installed) {
      return 'Install Claude Code or Codex first.';
    }
    return null;
  }, [trimmedName, inFlight, installed, runner]);

  const generateDisabled = submitting || installed === null || disableReason !== null;

  async function start(): Promise<void> {
    if (generateDisabled) return;
    setSubmitting(true);
    try {
      setOpen(false);
      await onGenerate({
        ...(runner ? { runnerOverride: runner } : {}),
        ...(model.trim() ? { modelOverride: model.trim() } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const triggerTitle = inFlight
    ? 'Already generating for this feature'
    : trimmedName.length === 0
      ? 'Name the section first'
      : `Generate a feature test plan for "${trimmedName}"`;

  return (
    <div ref={wrapRef} className="plan-editor-run-wrap">
      <button
        type="button"
        className="btn ghost icon"
        onClick={() => {
          if (inFlight || trimmedName.length === 0) return;
          setOpen((v) => !v);
        }}
        disabled={inFlight || trimmedName.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerTitle}
        data-testid="plan-section-generate"
      >
        <Icon.Sparkles size={11} />
      </button>

      {open ? (
        <div className="plan-run-popover" role="dialog" aria-label="Generate feature test plan">
          <div className="plan-run-popover-title">Generate test plan</div>
          <div className="plan-run-popover-sub">
            Drafts a new feature-scoped plan for <strong>{trimmedName || 'this section'}</strong>{' '}
            using the model and runner you pick. The current plan is untouched.
          </div>
          <div className="plan-run-popover-field">
            <label className="new-plan-label" htmlFor="plan-section-runner">
              Runner
            </label>
            <select
              id="plan-section-runner"
              className="file-issue-input"
              value={runner}
              onChange={(e) => {
                const next = e.target.value as '' | 'claude' | 'codex';
                setRunner(next);
                // Model id namespace differs between runners — reset on flip.
                setModel('');
              }}
            >
              <option value="">Use default</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="plan-run-popover-field">
            <label className="new-plan-label" htmlFor="plan-section-model">
              Model
            </label>
            <ModelSelect
              id="plan-section-model"
              runner={runner}
              value={model}
              onChange={setModel}
            />
          </div>
          <div className="plan-run-popover-actions">
            <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => void start()}
              disabled={generateDisabled}
              title={disableReason ?? undefined}
              data-testid="plan-section-generate-start"
            >
              <Icon.Sparkles size={11} /> Generate
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const AGENT_OPTIONS: AgentName[] = ['qa-hunter', 'manual-qa', 'ios-qa-pilot', 'ux-expert'];

function AgentMultiSelect({
  value,
  onChange,
}: {
  value: AgentName[];
  onChange: (next: AgentName[]) => void;
}): ReactElement {
  function toggle(agent: AgentName): void {
    if (value.includes(agent)) {
      // Always keep at least one agent selected — a plan that targets
      // nobody can't be run by anyone.
      if (value.length === 1) return;
      onChange(value.filter((a) => a !== agent));
    } else {
      onChange([...value, agent]);
    }
  }
  return (
    <span
      className="plan-editor-agent-chips"
      role="group"
      aria-label="QA agents this plan applies to"
      data-testid="plan-agent-chips"
    >
      {AGENT_OPTIONS.map((a) => {
        const on = value.includes(a);
        return (
          <button
            key={a}
            type="button"
            className={`pill plan-editor-agent-chip${on ? ' selected' : ''}`}
            aria-pressed={on}
            onClick={() => toggle(a)}
            data-testid={`plan-agent-chip-${a}`}
            title={
              on
                ? value.length === 1
                  ? `${labelForAgent(a)} — at least one agent must stay selected`
                  : `Remove ${labelForAgent(a)} from this plan`
                : `Make this plan runnable by ${labelForAgent(a)}`
            }
          >
            {labelForAgent(a)}
          </button>
        );
      })}
    </span>
  );
}

function PlanTitleEditable({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className="plan-editor-title"
      onBlur={() => {
        const next = (ref.current?.textContent ?? '').trim();
        if (next && next !== value.trim()) onCommit(next);
        else if (ref.current) ref.current.textContent = value;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      role="textbox"
      aria-label="Plan name"
    >
      {value}
    </div>
  );
}

function SectionHeader({
  block,
  count,
  onTitleChange,
  onAddCase,
  onDelete,
  onMoveUp,
  onMoveDown,
  generateSlot,
}: {
  block: Extract<TestPlanBlock, { kind: 'section' }>;
  count: number;
  onTitleChange: (title: string) => void;
  onAddCase: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  generateSlot?: ReactNode;
}): ReactElement {
  return (
    <div className="plan-section-card-head" data-section-id={block.id}>
      <EditableText
        className="plan-section-title"
        value={block.title}
        placeholder="Section name"
        onCommit={onTitleChange}
      />
      <span className="plan-section-count">
        {count} case{count === 1 ? '' : 's'}
      </span>
      <div className="plan-block-actions">
        {generateSlot}
        <button type="button" className="btn ghost icon" onClick={onAddCase} title="Add test case">
          <Icon.Plus size={11} />
        </button>
        <button type="button" className="btn ghost icon" onClick={onMoveUp} title="Move up">
          <Icon.ChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button type="button" className="btn ghost icon" onClick={onMoveDown} title="Move down">
          <Icon.ChevronDown size={11} />
        </button>
        <button type="button" className="btn ghost icon" onClick={onDelete} title="Delete section">
          <Icon.Trash size={11} />
        </button>
      </div>
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
      <SeverityChip value={block.severity} onChange={(severity) => onChange({ severity })} />
      <div className="plan-case-body">
        <EditableText
          className="plan-case-title"
          value={block.title}
          placeholder="Test case title"
          onCommit={(title) => onChange({ title })}
        />
        <div className="plan-case-meta">
          <label className="plan-case-meta-row">
            <span className="plan-case-meta-key">Expected</span>
            <EditableText
              className="plan-case-meta-value"
              value={block.expected ?? ''}
              placeholder="What success looks like"
              onCommit={(v) => onChange({ expected: v.trim() ? v : null })}
            />
          </label>
          <label className="plan-case-meta-row">
            <span className="plan-case-meta-key">Repro</span>
            <EditableText
              className="plan-case-meta-value"
              value={block.repro ?? ''}
              placeholder="Steps the agent should follow"
              onCommit={(v) => onChange({ repro: v.trim() ? v : null })}
            />
          </label>
          <label className="plan-case-meta-row">
            <span className="plan-case-meta-key">Scope</span>
            <EditableText
              className="plan-case-meta-value"
              value={(block.scope ?? []).join(', ')}
              placeholder="Comma-separated labels (e.g. auth, checkout)"
              onCommit={(v) => {
                const next = v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChange({ scope: next.length > 0 ? next : null });
              }}
            />
          </label>
        </div>
      </div>
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
  );
}

function SeverityChip({
  value,
  onChange,
}: {
  value: FindingSeverity | null;
  onChange: (next: FindingSeverity | null) => void;
}): ReactElement {
  const next: Record<string, FindingSeverity | null> = {
    '': 'P0',
    P0: 'P1',
    P1: 'P2',
    P2: null,
  };
  const className = `plan-case-sev${value ? ` sev-${value.toLowerCase()}` : ' sev-none'}`;
  return (
    <button
      type="button"
      className={className}
      onClick={() => onChange(next[value ?? ''] ?? 'P0')}
      title="Cycle severity (P0 → P1 → P2 → none)"
      aria-label={`Severity ${value ?? 'none'}`}
    >
      {value ?? '—'}
    </button>
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
  mapFeatures,
  onClose,
  onChange,
  onSubmit,
}: {
  state: NewPlanState;
  mapFeatures: string[];
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
          <div className="modal-title">Draft a test plan</div>
          <div className="modal-body">
            We&rsquo;ll scan the repo and produce a structured plan you can review. Every case is
            editable, and you can switch which agent runs it from the plan&rsquo;s header.
          </div>

          <div className="new-plan-field">
            <label className="new-plan-label">Scope</label>
            <div className="new-plan-segmented">
              <button
                type="button"
                className={`new-plan-seg${state.scope === 'whole-app' ? ' active' : ''}`}
                onClick={() => onChange({ scope: 'whole-app' })}
                disabled={state.busy}
              >
                Whole app
              </button>
              <button
                type="button"
                className={`new-plan-seg${state.scope === 'feature' ? ' active' : ''}`}
                onClick={() => onChange({ scope: 'feature' })}
                disabled={state.busy}
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
                list="new-plan-map-features"
                value={state.featureName}
                onChange={(e) => onChange({ featureName: e.target.value })}
                placeholder={
                  mapFeatures.length > 0
                    ? `e.g. ${mapFeatures.slice(0, 3).join(', ')}`
                    : 'e.g. checkout, sign-in, settings'
                }
                disabled={state.busy}
                autoFocus
              />
              {mapFeatures.length > 0 ? (
                <datalist id="new-plan-map-features">
                  {mapFeatures.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              ) : null}
              <div className="new-plan-hint">
                {mapFeatures.length > 0
                  ? 'Pick a coverage-map feature so the plan aligns with the radar.'
                  : 'No coverage map yet — generate one from the Coverage screen first for best results.'}
              </div>
            </div>
          ) : null}

          <div className="new-plan-generator-row">
            <div className="new-plan-field">
              <label className="new-plan-label" htmlFor="plan-runner-override">
                Runner
              </label>
              <select
                id="plan-runner-override"
                className="file-issue-input"
                value={state.runnerOverride}
                onChange={(e) =>
                  onChange({ runnerOverride: e.target.value as '' | 'claude' | 'codex' })
                }
                disabled={state.busy}
                title="Which CLI to drive — empty uses your Settings default"
              >
                <option value="">Use Settings default</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="new-plan-field">
              <label className="new-plan-label" htmlFor="plan-model-override">
                Model
              </label>
              <ModelSelect
                id="plan-model-override"
                runner={state.runnerOverride}
                value={state.modelOverride}
                onChange={(next) => onChange({ modelOverride: next })}
                disabled={state.busy}
              />
            </div>
          </div>

          <label className="new-plan-focus">
            <input
              type="checkbox"
              checked={state.focusOnChangedOrUncovered}
              onChange={(e) => onChange({ focusOnChangedOrUncovered: e.target.checked })}
              disabled={state.busy}
            />
            <div>
              <div className="new-plan-focus-label">
                Focus on what changed or isn&rsquo;t covered yet
              </div>
              <div className="new-plan-focus-hint">
                Bias the AI toward files the Coverage screen flags as uncovered, recently churned,
                or carrying open findings. Falls through to the regular prompt when there&rsquo;s no
                signal yet.
              </div>
            </div>
          </label>

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
                  Starting…
                </>
              ) : (
                <>
                  <Icon.Sparkles size={12} /> Draft plan
                </>
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
    scope: null,
  };
}
