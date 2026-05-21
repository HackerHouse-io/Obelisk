import { useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../../icons';
import { showApiAlert } from '../../state/alert-store';
import { findActiveRun, RunRow, type ActiveRun, type RunnerInstalled } from './FeatureCard';
import type { AgentName, CoverageFeature, TestPlanGenerationJob } from '../../../shared/types';

interface Props {
  repoId: string;
  features: CoverageFeature[];
  installed: RunnerInstalled | null;
  activeRuns: ActiveRun[];
  planJobs: Record<string, TestPlanGenerationJob>;
  selectedLabel: string | null;
  onSelectRow: (label: string) => void;
  onChange: () => void;
}

type SortKey = 'coverage' | 'name' | 'files' | 'cases' | 'findings';
type SortDir = 'asc' | 'desc';
type Filter = 'all' | 'under-50' | 'no-plan' | 'has-findings';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'under-50', label: 'Under 50%' },
  { id: 'no-plan', label: 'No plan' },
  { id: 'has-findings', label: 'Has findings' },
];

/**
 * Sortable, filterable table that replaces the unreadable giant-radar
 * modal. Scales linearly with feature count — works whether the user has
 * 5 features or 500.
 */
export function CoverageFeaturesTable({
  repoId,
  features,
  installed,
  activeRuns,
  planJobs,
  selectedLabel,
  onSelectRow,
  onChange,
}: Props): ReactElement {
  const [sortKey, setSortKey] = useState<SortKey>('coverage');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const runnersOk = installed ? installed.claude.installed || installed.codex.installed : null;
  const runnersHint =
    installed && !runnersOk
      ? (installed.claude.hint ?? installed.codex.hint ?? 'No coding-agent CLI on PATH.')
      : null;

  const jobByLabel = useMemo(() => {
    const map = new Map<string, TestPlanGenerationJob>();
    for (const j of Object.values(planJobs)) {
      if (j.feature) map.set(j.feature.toLowerCase(), j);
    }
    return map;
  }, [planJobs]);

  const rows = useMemo(() => {
    const filtered = features.filter((f) => {
      switch (filter) {
        case 'under-50':
          return f.coveragePct < 50;
        case 'no-plan':
          return f.planRefs.length === 0;
        case 'has-findings':
          return f.openFindings > 0;
        default:
          return true;
      }
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.label.localeCompare(b.label) * dir;
        case 'coverage':
          return (a.coveragePct - b.coveragePct) * dir;
        case 'files':
          return (a.filesWithCases - b.filesWithCases) * dir;
        case 'cases':
          return (a.caseCount - b.caseCount) * dir;
        case 'findings':
          return (a.openFindings - b.openFindings) * dir;
      }
    });
  }, [features, filter, sortKey, sortDir]);

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  async function handleGenerate(label: string): Promise<void> {
    if (jobByLabel.has(label)) return;
    setBusy(`gen:${label}`);
    try {
      const res = await window.obelisk.invoke('testPlans:generate', {
        repoId,
        agentName: 'qa-hunter',
        scope: 'feature',
        featureName: label,
        focusOnChangedOrUncovered: true,
      });
      if (!res.ok) showApiAlert(res.error, 'generate test plan');
      else onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="coverage-table-card" data-testid="coverage-features-table">
      <div className="coverage-table-filter-strip" role="radiogroup" aria-label="Feature filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            className={`coverage-table-filter-chip${filter === f.id ? ' active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <div className="coverage-table-count">
          {rows.length} of {features.length}
        </div>
      </div>

      <div className="coverage-features-table" role="table">
        <div className="coverage-features-table-head" role="row">
          <TableHeader
            label="Feature"
            k="name"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
          />
          <TableHeader
            label="Coverage"
            k="coverage"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            numeric
          />
          <TableHeader
            label="Files"
            k="files"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            numeric
          />
          <TableHeader
            label="Cases"
            k="cases"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            numeric
          />
          <TableHeader
            label="Findings"
            k="findings"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            numeric
          />
          <div className="coverage-features-th">Plan</div>
          <div className="coverage-features-th">Actions</div>
        </div>
        {rows.length === 0 ? (
          <div className="coverage-table-empty">No features match this filter.</div>
        ) : (
          rows.map((f) => {
            const job = jobByLabel.get(f.label);
            const generating = job !== undefined;
            const hasPlan = f.planRefs.length > 0;
            const planRows: { plan: (typeof f.planRefs)[number]; agentName: AgentName }[] = [];
            for (const plan of f.planRefs) {
              for (const agentName of plan.agentNames) {
                planRows.push({ plan, agentName });
              }
            }
            return (
              <div
                key={f.label}
                className={`coverage-features-row${selectedLabel === f.label ? ' selected' : ''}`}
                role="row"
                data-testid={`coverage-table-row-${f.label}`}
                onClick={() => onSelectRow(f.label)}
              >
                <div className="coverage-features-cell coverage-features-cell-name">{f.label}</div>
                <div className="coverage-features-cell coverage-features-cell-coverage">
                  <div className="coverage-features-cell-bar">
                    <div
                      className={`coverage-features-cell-bar-fill ${tone(f.coveragePct)}`}
                      style={{ width: `${f.coveragePct}%` }}
                    />
                  </div>
                  <span className={`coverage-features-cell-pct ${tone(f.coveragePct)}`}>
                    {f.coveragePct}%
                  </span>
                </div>
                <div className="coverage-features-cell num">
                  {f.filesWithCases}/{f.filesInGlob}
                </div>
                <div className="coverage-features-cell num">
                  {f.casesPassed}/{f.caseCount}
                </div>
                <div className={`coverage-features-cell num${f.openFindings > 0 ? ' bad' : ''}`}>
                  {f.openFindings}
                </div>
                <div className="coverage-features-cell">
                  {hasPlan
                    ? f.planRefs.length === 1
                      ? f.planRefs[0]!.name
                      : `${f.planRefs.length} plans`
                    : '—'}
                </div>
                <div
                  className="coverage-features-cell coverage-features-cell-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!hasPlan ? (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busy !== null || generating || installed === null || !runnersOk}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleGenerate(f.label);
                      }}
                      title={generating ? job!.status : 'Generate a feature-scoped test plan'}
                      data-testid={`coverage-table-generate-${f.label}`}
                    >
                      {generating ? (
                        <Icon.Spinner
                          size={11}
                          style={{ animation: 'spin 0.9s linear infinite' }}
                        />
                      ) : (
                        <Icon.Sparkles size={11} />
                      )}{' '}
                      {generating ? stageShort(job!) : 'Plan'}
                    </button>
                  ) : (
                    planRows.map(({ plan, agentName }) => (
                      <RunRow
                        key={`${plan.id}:${agentName}`}
                        repoId={repoId}
                        featureLabel={f.label}
                        plan={plan}
                        agentName={agentName}
                        installed={installed}
                        runnersOk={runnersOk}
                        runnersHint={runnersHint}
                        activeRun={findActiveRun(activeRuns, plan.id, agentName)}
                        onChange={onChange}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function TableHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  numeric,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  numeric?: boolean;
}): ReactElement {
  const active = k === sortKey;
  return (
    <button
      type="button"
      className={`coverage-features-th${active ? ' active' : ''}${numeric ? ' num' : ''}`}
      onClick={() => onSort(k)}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`coverage-table-sort-${k}`}
    >
      {label}
      {active ? <span aria-hidden="true">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
    </button>
  );
}

function tone(pct: number): 'ok' | 'mid' | 'bad' {
  if (pct >= 70) return 'ok';
  if (pct >= 40) return 'mid';
  return 'bad';
}

function stageShort(job: TestPlanGenerationJob): string {
  switch (job.stage) {
    case 'queued':
      return 'Queued';
    case 'spawning':
      return 'Starting';
    case 'reading':
      return 'Reading';
    case 'drafting':
      return 'Drafting';
    case 'writing':
      return 'Saving';
    default:
      return 'Working';
  }
}
