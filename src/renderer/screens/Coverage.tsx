import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { showApiAlert, showAlert } from '../state/alert-store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { CoverageRadar } from './coverage/CoverageRadar';
import { CoverageFeaturesTable } from './coverage/CoverageFeaturesTable';
import { FeatureCard, type ActiveRun, type RunnerInstalled } from './coverage/FeatureCard';
import { WholeAppPlansCard } from './coverage/WholeAppPlansCard';
import type {
  BusEvent,
  CoverageEntry,
  CoverageFeature,
  CoverageMapGenerationJob,
  CoverageReport,
  TestPlanGenerationJob,
} from '../../shared/types';

type Filter = 'all' | 'uncovered' | 'recent-churn' | 'has-findings';
type SortKey = 'path' | 'cases' | 'findings' | 'lastPass' | 'churn';
type SortDir = 'asc' | 'desc';

const FILTERS: { id: Filter; label: string; help: string }[] = [
  { id: 'all', label: 'All', help: 'Every tracked file' },
  { id: 'uncovered', label: 'Uncovered', help: 'No test case targets this file' },
  {
    id: 'recent-churn',
    label: 'Churn since last pass',
    help: 'Commits touched this file after the most recent passing run that exercised it',
  },
  {
    id: 'has-findings',
    label: 'Open findings',
    help: 'Open previews mention this file in their suspected_files',
  },
];

export function Coverage(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [report, setReport] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null);
  const [installed, setInstalled] = useState<RunnerInstalled | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  /** Live LLM-generation job, if any. Drives the progress card. */
  const [genJob, setGenJob] = useState<CoverageMapGenerationJob | null>(null);
  const [radarExpanded, setRadarExpanded] = useState(false);
  /** "Keep existing labels" toggle in the regenerate dialog. Default unchecked → REPLACE. */
  const [regenKeepExisting, setRegenKeepExisting] = useState(false);
  const [cleanStaleConfirmOpen, setCleanStaleConfirmOpen] = useState(false);
  const [cleanStaleBusy, setCleanStaleBusy] = useState(false);
  /**
   * All in-flight test plan generation jobs for this repo. Keyed by jobId
   * so updates from the bus replace rather than append. Passed to each
   * FeatureCard so it can disable its "Generate test plan" button when a
   * job for that feature is in flight — even after the user navigates
   * away and back (hydrated from `testPlans:generationJobs` on mount).
   */
  const [planJobs, setPlanJobs] = useState<Record<string, TestPlanGenerationJob>>({});
  /**
   * Live (queued/running/publishing/paused) runs for this repo. Drives the
   * per-(plan, agent) "Running…" state on feature cards so the renderer
   * never lets the user dispatch a duplicate. Refreshed on every
   * `run.created` / `run.transition` event from the bus.
   */
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const onSort = (key: SortKey): void => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('desc');
      return;
    }
    if (sortDir === 'desc') {
      setSortDir('asc');
      return;
    }
    setSortKey(null);
    setSortDir('desc');
  };

  const load = useCallback(async (): Promise<void> => {
    if (!repo) return;
    setLoading(true);
    setError(null);
    const res = await window.obelisk.invoke('coverage:list', { repoId: repo.id });
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setReport(res.value);
  }, [repo]);

  useEffect(() => {
    void load();
  }, [load]);

  // Probe runner availability so feature-card CTAs can disable themselves
  // when no CLI is on PATH. Match the same shape TestPlans uses.
  useEffect(() => {
    let cancelled = false;
    void window.obelisk.invoke('runners:installed', {}).then((res) => {
      if (cancelled) return;
      if (res.ok) setInstalled(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate live-runs on mount and on every repo change. The bus subscription
  // below refreshes this whenever a run is created / transitions, but the
  // initial paint needs a one-shot fetch so a card mounted mid-run shows
  // "Running…" without waiting for the next event.
  const refreshActiveRuns = useCallback(async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('runs:activeForRepo', { repoId: repo.id });
    if (!res.ok) return;
    // Skip the setState when nothing actually changed — bus events fire for
    // every run.* transition app-wide, and an unconditional set would
    // cascade re-renders across every FeatureCard on stable data.
    setActiveRuns((prev) => (sameActiveRuns(prev, res.value) ? prev : res.value));
  }, [repo]);

  useEffect(() => {
    void refreshActiveRuns();
  }, [refreshActiveRuns]);

  // Live refresh: re-pull the report when a run finishes or a plan changes.
  // Throttle to one in-flight load to keep the radar's tween from jittering.
  useEffect(() => {
    if (!repo) return;
    let pending = false;
    let scheduled = false;
    function refresh(): void {
      if (pending) {
        scheduled = true;
        return;
      }
      pending = true;
      void load().finally(() => {
        pending = false;
        if (scheduled) {
          scheduled = false;
          refresh();
        }
      });
    }
    return window.obelisk.subscribe((event: BusEvent) => {
      if (event.type === 'run.created' || event.type === 'run.transition') {
        // Refresh active-runs whenever any run moves; cheap query and keeps
        // the per-card "Running…" state in sync with the DB without needing
        // to filter the event payload to "is this run for our repo".
        void refreshActiveRuns();
      }
      if (event.type === 'run.transition' && (event.state === 'done' || event.state === 'failed')) {
        refresh();
      } else if (event.type === 'testPlans.changed' && event.repoId === repo.id) {
        refresh();
      } else if (event.type === 'previews.changed' && event.repoId === repo.id) {
        refresh();
      } else if (event.type === 'testPlanGeneration.progress' && event.job.repoId === repo.id) {
        const job = event.job;
        setPlanJobs((cur) => {
          if (job.stage === 'done' || job.stage === 'failed') {
            const next = { ...cur };
            delete next[job.jobId];
            return next;
          }
          return { ...cur, [job.jobId]: job };
        });
        if (job.stage === 'done') refresh();
      } else if (event.type === 'coverageMapGeneration.progress' && event.job.repoId === repo.id) {
        setGenJob(event.job);
        if (event.job.stage === 'done') {
          refresh();
          const n = event.job.addedLabels?.length ?? 0;
          showAlert({
            title: n > 0 ? `Added ${n} new label${n === 1 ? '' : 's'}` : 'Map already up to date',
            body:
              n > 0
                ? (event.job.addedLabels ?? []).join(', ')
                : `qa/coverage-map.md already covers every feature Claude found (${event.job.labelCount ?? 0} label${event.job.labelCount === 1 ? '' : 's'}).`,
          });
        } else if (event.job.stage === 'failed') {
          showAlert({
            title: 'Coverage map generation failed',
            body:
              event.job.errorMessage + (event.job.errorHint ? '\n\n' + event.job.errorHint : ''),
          });
        }
      }
    });
  }, [repo, load, refreshActiveRuns]);

  // Hydrate any in-flight job on mount so the progress card survives a route change.
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void window.obelisk.invoke('coverage:generationJobs', { repoId: repo.id }).then((res) => {
      if (cancelled || !res.ok) return;
      const inflight = res.value.find((j) => j.stage !== 'done' && j.stage !== 'failed');
      if (inflight) setGenJob(inflight);
    });
    // Hydrate in-flight test plan generation jobs so the FeatureCard
    // buttons reflect background work that started before this mount
    // (e.g. user clicked Generate, navigated to Mission Control, came back).
    void window.obelisk.invoke('testPlans:generationJobs', { repoId: repo.id }).then((res) => {
      if (cancelled || !res.ok) return;
      const next: Record<string, TestPlanGenerationJob> = {};
      for (const j of res.value) {
        if (j.stage === 'done' || j.stage === 'failed') continue;
        next[j.jobId] = j;
      }
      setPlanJobs(next);
    });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const filteredFeature = useMemo<CoverageFeature | null>(() => {
    if (!report || !selectedFeature) return null;
    return report.features.find((f) => f.label === selectedFeature) ?? null;
  }, [report, selectedFeature]);

  // When a feature is selected, open the file panel and scope it to that feature's files.
  useEffect(() => {
    if (selectedFeature) setFilesOpen(true);
  }, [selectedFeature]);

  const filteredFiles = useMemo(() => {
    if (!report) return [] as CoverageEntry[];
    const featureFiles = filteredFeature ? new Set(filteredFeature.files) : null;
    const q = search.trim().toLowerCase();
    const filtered = report.files.filter((f) => {
      if (featureFiles && !featureFiles.has(f.path)) return false;
      if (q && !f.path.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'uncovered':
          return f.caseCount === 0;
        case 'recent-churn':
          return f.churnSinceLastPass > 0;
        case 'has-findings':
          return f.findingsCount > 0;
        default:
          return true;
      }
    });
    if (sortKey === null) return filtered;
    const dir = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: CoverageEntry, b: CoverageEntry): number => {
      switch (sortKey) {
        case 'path':
          return a.path.localeCompare(b.path) * dir;
        case 'cases':
          return (a.caseCount - b.caseCount) * dir;
        case 'findings':
          return (a.findingsCount - b.findingsCount) * dir;
        case 'churn':
          return (a.churnSinceLastPass - b.churnSinceLastPass) * dir;
        case 'lastPass': {
          if (a.lastPassedAt === null && b.lastPassedAt === null) return 0;
          if (a.lastPassedAt === null) return 1;
          if (b.lastPassedAt === null) return -1;
          return a.lastPassedAt.localeCompare(b.lastPassedAt) * dir;
        }
      }
    };
    return [...filtered].sort(cmp);
  }, [report, filter, search, sortKey, sortDir, filteredFeature]);

  /**
   * Spawn the LLM-driven coverage-map generator. Same flow test plan
   * generation uses: fire-and-forget job, progress streamed via the bus.
   * If no CLI is installed, fall back to the heuristic file scan so the
   * user still gets *something* without a runner on PATH.
   */
  async function generateMap(): Promise<void> {
    if (!repo || bootstrapBusy || genJob !== null) return;
    setBootstrapBusy(true);
    try {
      // Resolve the installed state at click time — `installed` may still be
      // null if the user clicks before the initial probe completes.
      let inst = installed;
      if (!inst) {
        const probe = await window.obelisk.invoke('runners:installed', {});
        if (probe.ok) {
          inst = probe.value;
          setInstalled(probe.value);
        }
      }
      const runnerOk = inst?.claude.installed || inst?.codex.installed;
      if (!runnerOk) {
        // No CLI on PATH — fall back to the file-scan heuristic so the user
        // isn't dead-ended on a fresh machine.
        await heuristicBootstrap();
        return;
      }
      // Default = REPLACE. `regenKeepExisting` is the dialog's checkbox.
      const res = await window.obelisk.invoke('coverage:generateMap', {
        repoId: repo.id,
        replace: !regenKeepExisting,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'generate coverage map');
      }
      // Progress / completion lands via the bus subscription above.
    } finally {
      setBootstrapBusy(false);
    }
  }

  async function cleanStaleLabels(): Promise<void> {
    if (!repo || cleanStaleBusy) return;
    setCleanStaleBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:cleanStaleLabels', { repoId: repo.id });
      if (!res.ok) {
        showApiAlert(res.error, 'clean stale labels');
        return;
      }
      await load();
      showAlert({
        title:
          res.value.removed.length > 0
            ? `Removed ${res.value.removed.length} broken label${res.value.removed.length === 1 ? '' : 's'}`
            : 'No broken labels to remove',
        body:
          res.value.removed.length > 0
            ? res.value.removed.slice(0, 10).join(', ') +
              (res.value.removed.length > 10 ? `, +${res.value.removed.length - 10} more` : '')
            : 'Every label in qa/coverage-map.md already matches at least one tracked file.',
      });
    } finally {
      setCleanStaleBusy(false);
      setCleanStaleConfirmOpen(false);
    }
  }

  /** Fallback bootstrap when no LLM CLI is available. */
  async function heuristicBootstrap(): Promise<void> {
    if (!repo) return;
    const previousLabels = new Set(report?.features.map((f) => f.label) ?? []);
    setBootstrapBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:bootstrapMap', {
        repoId: repo.id,
        commit: true,
        force: true,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'bootstrap coverage map');
        return;
      }
      await load();
      const newLabels = res.value.proposals.map((p) => p.label);
      const added = newLabels.filter((l) => !previousLabels.has(l));
      showAlert({
        title:
          added.length > 0
            ? `Added ${added.length} new label${added.length === 1 ? '' : 's'} (heuristic scan)`
            : 'Map already up to date',
        body:
          added.length > 0
            ? added.join(', ')
            : `${newLabels.length} label${newLabels.length === 1 ? '' : 's'} match the filesystem scan. Install Claude Code or Codex for a deeper LLM-driven scan.`,
      });
    } finally {
      setBootstrapBusy(false);
    }
  }

  function openRegenerateConfirm(): void {
    if (!repo || bootstrapBusy || genJob !== null) return;
    setRegenConfirmOpen(true);
  }

  function onRegenerateConfirmed(): void {
    setRegenConfirmOpen(false);
    void generateMap().finally(() => setRegenKeepExisting(false));
  }

  function dismissJobToast(): void {
    if (!genJob) return;
    const jobId = genJob.jobId;
    setGenJob(null);
    void window.obelisk.invoke('coverage:dismissJob', { jobId });
  }

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Coverage shows which features are well-tested and which need more attention. Connect a repo first."
      />
    );
  }

  const features = report?.features ?? [];
  // Cap the radar at 8 axes — beyond that, labels overlap and the chart
  // becomes unreadable. The full feature list lives in the cards below and
  // in the sortable table that opens from the Expand button.
  const RADAR_CAP = 8;
  const radarFeatures = features.slice(0, RADAR_CAP);
  const overflowCount = Math.max(0, features.length - radarFeatures.length);
  const staleLabels = report?.staleLabels ?? [];
  const avgCoverage =
    features.length > 0
      ? Math.round(features.reduce((sum, f) => sum + f.coveragePct, 0) / features.length)
      : 0;
  const lowCoverage = features.filter((f) => f.coveragePct < 50).length;

  return (
    <div className="coverage-screen">
      <header className="coverage-header">
        <div>
          <div className="coverage-title">Coverage</div>
          <div className="coverage-sub">
            One score per feature, driven by your test plans and runs. Each QA Hunter / iOS Pilot /
            Manual QA run nudges its feature&apos;s axis outward — churn and open findings pull it
            in.
          </div>
        </div>
        <div className="coverage-header-actions">
          {report?.hasCoverageMap ? (
            <button
              type="button"
              className="btn sm"
              onClick={openRegenerateConfirm}
              disabled={bootstrapBusy || loading}
              title="Rewrite qa/coverage-map.md from a fresh codebase scan"
              data-testid="coverage-regenerate-btn"
            >
              {bootstrapBusy ? (
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
              ) : (
                <Icon.Sparkles size={11} />
              )}{' '}
              {bootstrapBusy ? 'Regenerating…' : 'Regenerate map'}
            </button>
          ) : null}
          <button type="button" className="btn sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
            ) : (
              <Icon.Refresh size={11} />
            )}{' '}
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="coverage-banner coverage-banner-error">
          <Icon.AlertTri size={12} />
          <div>{error}</div>
        </div>
      ) : null}

      {report && !report.hasCoverageMap && !genJob ? (
        <div className="coverage-banner coverage-banner-info">
          {bootstrapBusy ? (
            <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
          ) : (
            <Icon.Sparkles size={12} />
          )}
          <div>
            {bootstrapBusy ? (
              <>Asking Claude / Codex to analyze the codebase…</>
            ) : (
              <>
                No <span className="mono">qa/coverage-map.md</span> yet — Claude / Codex will read
                your codebase and propose feature labels.
              </>
            )}
          </div>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => void generateMap()}
            disabled={bootstrapBusy}
            data-testid="coverage-bootstrap-btn"
          >
            {bootstrapBusy ? (
              <>
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
                Generating…
              </>
            ) : (
              'Generate coverage map'
            )}
          </button>
        </div>
      ) : null}

      {genJob ? <CoverageGenProgress job={genJob} onDismiss={dismissJobToast} /> : null}

      {report ? (
        <>
          <div className="coverage-radar-section">
            <div className="coverage-radar-stage">
              <button
                type="button"
                className="coverage-radar-expand-btn"
                onClick={() => setRadarExpanded(true)}
                title="Expand radar to fullscreen"
                aria-label="Expand radar"
                data-testid="coverage-radar-expand"
              >
                <Icon.Search size={11} /> Expand
              </button>
              <CoverageRadar
                features={radarFeatures}
                selectedLabel={selectedFeature}
                onSelect={setSelectedFeature}
              />
              {overflowCount > 0 ? (
                <div className="coverage-radar-overflow">
                  +{overflowCount} more in cards below — click <em>Expand</em> for all
                </div>
              ) : null}
            </div>
            <div className="coverage-radar-summary">
              <div className="coverage-summary-stat">
                <div className="coverage-summary-stat-value">{avgCoverage}%</div>
                <div className="coverage-summary-stat-label">average coverage</div>
              </div>
              <div className="coverage-summary-stat">
                <div className="coverage-summary-stat-value">{features.length}</div>
                <div className="coverage-summary-stat-label">features tracked</div>
              </div>
              <div className="coverage-summary-stat">
                <div className={`coverage-summary-stat-value${lowCoverage > 0 ? ' warn' : ''}`}>
                  {lowCoverage}
                </div>
                <div className="coverage-summary-stat-label">below 50%</div>
              </div>
              <div className="coverage-summary-stat">
                <div className="coverage-summary-stat-value text">
                  {report.lastDoneAt ? short(report.lastDoneAt) : '—'}
                </div>
                <div className="coverage-summary-stat-label">last QA pass</div>
              </div>
              {staleLabels.length > 0 ? (
                <div className="coverage-summary-stale" data-testid="coverage-stale-labels">
                  <div className="coverage-summary-stale-title">
                    {staleLabels.length} broken label{staleLabels.length === 1 ? '' : 's'}
                  </div>
                  <div className="coverage-summary-stale-list">
                    {staleLabels.slice(0, 8).join(', ')}
                    {staleLabels.length > 8 ? `, +${staleLabels.length - 8} more` : ''}
                  </div>
                  <div className="coverage-summary-stale-hint">
                    Globs in <span className="mono">qa/coverage-map.md</span> match zero tracked
                    files. Remove them in one click — or edit the file to fix the globs.
                  </div>
                  <button
                    type="button"
                    className="btn sm danger coverage-summary-stale-btn"
                    onClick={() => setCleanStaleConfirmOpen(true)}
                    disabled={cleanStaleBusy}
                    data-testid="coverage-clean-stale-btn"
                  >
                    {cleanStaleBusy ? (
                      <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
                    ) : (
                      <Icon.Close size={11} />
                    )}{' '}
                    Remove {staleLabels.length} broken label{staleLabels.length === 1 ? '' : 's'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <WholeAppPlansCard
            repoId={repo.id}
            plans={report.wholeAppPlans}
            installed={installed}
            activeRuns={activeRuns}
            onChange={() => void load()}
          />

          {features.length > 0 ? (
            <div className="coverage-feature-grid">
              {features.map((f) => {
                const job = Object.values(planJobs).find(
                  (j) => (j.feature ?? '').toLowerCase() === f.label.toLowerCase(),
                );
                return (
                  <FeatureCard
                    key={f.label}
                    repoId={repo.id}
                    feature={f}
                    selected={selectedFeature === f.label}
                    installed={installed}
                    activeRuns={activeRuns}
                    planJob={job ?? null}
                    onSelect={() => setSelectedFeature((cur) => (cur === f.label ? null : f.label))}
                    onChange={() => void load()}
                  />
                );
              })}
            </div>
          ) : null}

          <details
            className="coverage-files-disclosure"
            open={filesOpen}
            onToggle={(e) => setFilesOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="coverage-files-summary">
              <span>
                Files
                {filteredFeature ? (
                  <>
                    {' '}
                    · <span className="coverage-files-scope">{filteredFeature.label}</span>
                  </>
                ) : null}
              </span>
              <span className="coverage-files-summary-count">
                {report.totalFiles} tracked · {report.coveredFiles} covered ·{' '}
                {report.uncoveredFiles} uncovered
              </span>
            </summary>
            <div className="coverage-controls">
              <div className="coverage-filter-strip" role="radiogroup" aria-label="Coverage filter">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={filter === f.id}
                    className={`coverage-filter-chip${filter === f.id ? ' active' : ''}`}
                    onClick={() => setFilter(f.id)}
                    title={f.help}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <input
                type="search"
                placeholder="Filter by path…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="coverage-search"
                spellCheck={false}
              />
            </div>

            <div className="coverage-table">
              <div className="coverage-table-head">
                <SortHeader
                  label="File"
                  sortKey="path"
                  current={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                />
                <SortHeader
                  label="Cases"
                  sortKey="cases"
                  current={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                  numeric
                />
                <SortHeader
                  label="Findings"
                  sortKey="findings"
                  current={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                  numeric
                />
                <SortHeader
                  label="Last pass"
                  sortKey="lastPass"
                  current={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                />
                <SortHeader
                  label="Churn since"
                  sortKey="churn"
                  current={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                  numeric
                />
              </div>
              {filteredFiles.length === 0 ? (
                <div className="coverage-empty">No files match this filter.</div>
              ) : (
                filteredFiles.slice(0, 500).map((f) => <CoverageRow key={f.path} entry={f} />)
              )}
              {filteredFiles.length > 500 ? (
                <div className="coverage-empty" style={{ color: 'var(--t-3)' }}>
                  Showing first 500 of {filteredFiles.length}. Refine with the filter above.
                </div>
              ) : null}
            </div>
          </details>
        </>
      ) : loading ? (
        <div className="coverage-empty">
          <Icon.Spinner size={14} style={{ animation: 'spin 0.9s linear infinite' }} /> Building
          coverage report…
        </div>
      ) : null}

      <ConfirmDialog
        open={regenConfirmOpen}
        title="Regenerate qa/coverage-map.md?"
        body={
          <>
            Claude (or Codex) will read your codebase end-to-end and propose{' '}
            <strong>5–8 high-level features</strong>. By default this <strong>replaces</strong> the
            existing file — previously the map was merge-only and accumulated stale labels over
            repeated runs. Typically takes 30–90 seconds.
            <label className="coverage-regen-keep">
              <input
                type="checkbox"
                checked={regenKeepExisting}
                onChange={(e) => setRegenKeepExisting(e.target.checked)}
                data-testid="coverage-regen-keep-existing"
              />
              Keep existing labels (merge — for incrementally adding new features only)
            </label>
          </>
        }
        confirmLabel="Regenerate"
        confirmIcon="Sparkles"
        onCancel={() => {
          setRegenConfirmOpen(false);
          setRegenKeepExisting(false);
        }}
        onConfirm={onRegenerateConfirmed}
      />

      <ConfirmDialog
        open={cleanStaleConfirmOpen}
        title={`Remove ${staleLabels.length} broken label${staleLabels.length === 1 ? '' : 's'}?`}
        body={
          <>
            These labels in <span className="mono">qa/coverage-map.md</span> match{' '}
            <strong>zero tracked files</strong> — they&apos;re broken globs that can&apos;t drive
            any test. Removing them cleans up the map and the radar.
            <div className="coverage-clean-stale-list">
              {staleLabels.slice(0, 12).join(', ')}
              {staleLabels.length > 12 ? `, +${staleLabels.length - 12} more` : ''}
            </div>
          </>
        }
        confirmLabel={cleanStaleBusy ? 'Removing…' : 'Remove labels'}
        tone="danger"
        onCancel={() => setCleanStaleConfirmOpen(false)}
        onConfirm={() => void cleanStaleLabels()}
      />

      {radarExpanded ? (
        <div
          className="modal-overlay coverage-radar-modal-overlay"
          onClick={() => setRadarExpanded(false)}
          data-testid="coverage-radar-modal"
        >
          <div
            className="coverage-radar-modal coverage-table-modal"
            role="dialog"
            aria-modal="true"
            aria-label="All features (sortable table)"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="coverage-radar-modal-head">
              <div>
                <div className="modal-title">All {features.length} features</div>
                <div className="coverage-radar-modal-sub">
                  Sort by any column. Click a row to focus that feature in the main view.
                </div>
              </div>
              <button
                type="button"
                className="btn ghost icon"
                onClick={() => setRadarExpanded(false)}
                aria-label="Close"
              >
                <Icon.Close size={11} />
              </button>
            </header>
            <div className="coverage-radar-modal-body coverage-table-modal-body">
              <CoverageFeaturesTable
                repoId={repo.id}
                features={features}
                installed={installed}
                activeRuns={activeRuns}
                planJobs={planJobs}
                selectedLabel={selectedFeature}
                onSelectRow={(label) => {
                  setSelectedFeature(label);
                  setRadarExpanded(false);
                }}
                onChange={() => void load()}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CoverageRow({ entry }: { entry: CoverageEntry }): ReactElement {
  const tone =
    entry.findingsCount > 0
      ? 'bad'
      : entry.caseCount === 0 && entry.churnSinceLastPass > 0
        ? 'warn'
        : entry.caseCount === 0
          ? 'cool'
          : entry.churnSinceLastPass > 0
            ? 'info'
            : 'ok';
  return (
    <div className={`coverage-row coverage-row-${tone}`}>
      <div className="coverage-path mono">{entry.path}</div>
      <div className="coverage-num">{entry.caseCount}</div>
      <div className="coverage-num">{entry.findingsCount}</div>
      <div className="coverage-pass">
        {entry.lastPassedAt ? short(entry.lastPassedAt) : 'never'}
      </div>
      <div className="coverage-num">{entry.churnSinceLastPass}</div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  numeric,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey | null;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  numeric?: boolean;
}): ReactElement {
  const active = current === sortKey;
  return (
    <div className={numeric ? 'coverage-num' : undefined}>
      <button
        type="button"
        className={`coverage-th${active ? ' active' : ''}`}
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {active ? (
          <span className="coverage-th-caret" aria-hidden="true">
            {dir === 'asc' ? '▲' : '▼'}
          </span>
        ) : null}
      </button>
    </div>
  );
}

function sameActiveRuns(a: ActiveRun[], b: ActiveRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.runId !== y.runId || x.state !== y.state) return false;
  }
  return true;
}

function short(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function CoverageGenProgress({
  job,
  onDismiss,
}: {
  job: CoverageMapGenerationJob;
  onDismiss: () => void;
}): ReactElement {
  const terminal = job.stage === 'done' || job.stage === 'failed';
  const tone =
    job.stage === 'failed'
      ? 'coverage-banner-error'
      : job.stage === 'done'
        ? 'coverage-banner-ok'
        : 'coverage-banner-info';
  return (
    <div
      className={`coverage-banner ${tone}`}
      data-testid="coverage-gen-progress"
      data-stage={job.stage}
    >
      {!terminal ? (
        <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
      ) : job.stage === 'failed' ? (
        <Icon.AlertTri size={12} />
      ) : (
        <Icon.Check size={12} />
      )}
      <div>
        <strong>{stageHeadline(job.stage)}</strong>
        <div className="coverage-banner-sub">{job.status}</div>
        {job.stage === 'failed' && job.errorMessage ? (
          <div className="coverage-banner-sub">{job.errorMessage}</div>
        ) : null}
        {job.stage === 'done' && (job.addedLabels?.length ?? 0) > 0 ? (
          <div className="coverage-banner-sub">Added: {(job.addedLabels ?? []).join(', ')}</div>
        ) : null}
      </div>
      {terminal ? (
        <button type="button" className="btn sm" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

function stageHeadline(stage: CoverageMapGenerationJob['stage']): string {
  switch (stage) {
    case 'queued':
      return 'Queued';
    case 'spawning':
      return 'Starting Claude/Codex…';
    case 'reading':
      return 'Analyzing the codebase…';
    case 'writing':
      return 'Writing coverage-map.md…';
    case 'done':
      return 'Coverage map ready';
    case 'failed':
      return 'Coverage map generation failed';
  }
}
