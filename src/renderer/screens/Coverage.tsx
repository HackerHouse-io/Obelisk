import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { showApiAlert, showAlert } from '../state/alert-store';
import { EmptyState } from '../ui/EmptyState';
import { CoverageRadar } from './coverage/CoverageRadar';
import { FeatureCard, type RunnerInstalled } from './coverage/FeatureCard';
import type { BusEvent, CoverageEntry, CoverageReport, CoverageFeature } from '../../shared/types';

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
      if (event.type === 'run.transition' && (event.state === 'done' || event.state === 'failed')) {
        refresh();
      } else if (event.type === 'testPlans.changed' && event.repoId === repo.id) {
        refresh();
      } else if (event.type === 'previews.changed' && event.repoId === repo.id) {
        refresh();
      }
    });
  }, [repo, load]);

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

  async function bootstrapMap(): Promise<void> {
    if (!repo || bootstrapBusy) return;
    setBootstrapBusy(true);
    try {
      const res = await window.obelisk.invoke('coverage:bootstrapMap', {
        repoId: repo.id,
        commit: true,
      });
      if (!res.ok) {
        showApiAlert(res.error, 'bootstrap coverage map');
        return;
      }
      if (!res.value.written) {
        showAlert({
          title: 'Coverage map already exists',
          body:
            res.value.reason ??
            'qa/coverage-map.md is already present — open it in your editor to tweak labels.',
        });
      }
      // Await the refresh so the busy state stays visible until the radar
      // is actually ready to render the new features.
      await load();
    } finally {
      setBootstrapBusy(false);
    }
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
            Manual QA run nudges its feature's axis outward — churn and open findings pull it in.
          </div>
        </div>
        <button type="button" className="btn sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />
          ) : (
            <Icon.Refresh size={11} />
          )}{' '}
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error ? (
        <div className="coverage-banner coverage-banner-error">
          <Icon.AlertTri size={12} />
          <div>{error}</div>
        </div>
      ) : null}

      {report && !report.hasCoverageMap ? (
        <div className="coverage-banner coverage-banner-info">
          {bootstrapBusy ? (
            <Icon.Spinner size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
          ) : (
            <Icon.Sparkles size={12} />
          )}
          <div>
            {bootstrapBusy ? (
              <>
                Scanning the repo and writing <span className="mono">qa/coverage-map.md</span>…
              </>
            ) : (
              <>
                No <span className="mono">qa/coverage-map.md</span> yet — the radar reads features
                from that file.
              </>
            )}
          </div>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => void bootstrapMap()}
            disabled={bootstrapBusy}
          >
            {bootstrapBusy ? (
              <>
                <Icon.Spinner size={11} style={{ animation: 'spin 0.9s linear infinite' }} />{' '}
                Bootstrapping…
              </>
            ) : (
              'Bootstrap coverage map'
            )}
          </button>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="coverage-radar-section">
            <div className="coverage-radar-stage">
              <CoverageRadar
                features={features}
                selectedLabel={selectedFeature}
                onSelect={setSelectedFeature}
              />
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
              {report.staleLabels.length > 0 ? (
                <div className="coverage-summary-stale">
                  <div className="coverage-summary-stale-title">Stale labels</div>
                  <div className="coverage-summary-stale-list">{report.staleLabels.join(', ')}</div>
                  <div className="coverage-summary-stale-hint">
                    These labels appear on test cases but match no tracked files. Update{' '}
                    <span className="mono">qa/coverage-map.md</span>.
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {features.length > 0 ? (
            <div className="coverage-feature-grid">
              {features.map((f) => (
                <FeatureCard
                  key={f.label}
                  repoId={repo.id}
                  feature={f}
                  selected={selectedFeature === f.label}
                  installed={installed}
                  onSelect={() => setSelectedFeature((cur) => (cur === f.label ? null : f.label))}
                  onChange={() => void load()}
                />
              ))}
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
