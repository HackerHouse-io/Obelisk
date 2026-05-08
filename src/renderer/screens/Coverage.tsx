import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { EmptyState } from '../ui/EmptyState';
import type { CoverageEntry, CoverageReport } from '../../shared/types';

type Filter = 'all' | 'uncovered' | 'recent-churn' | 'has-findings';

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
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

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

  const filteredFiles = useMemo(() => {
    if (!report) return [] as CoverageEntry[];
    const q = search.trim().toLowerCase();
    return report.files.filter((f) => {
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
  }, [report, filter, search]);

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Coverage shows which files are exercised by your test plans, where findings cluster, and what's drifted since the last QA pass. Connect a repo first."
      />
    );
  }

  return (
    <div className="coverage-screen">
      <header className="coverage-header">
        <div>
          <div className="coverage-title">Coverage</div>
          <div className="coverage-sub">
            Per-file map of test cases, open findings, last passing QA run, and git churn since
            then. Add labels to your test cases (and a{' '}
            <span className="mono">qa/coverage-map.md</span> file) so each case maps to the files it
            exercises.
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

      {report ? (
        <>
          <div className="coverage-stats">
            <CoverageStat label="Tracked files" value={report.totalFiles} sub="from git ls-files" />
            <CoverageStat
              label="Covered"
              value={report.coveredFiles}
              sub={`${pct(report.coveredFiles, report.totalFiles)} of files`}
              tone="ok"
            />
            <CoverageStat
              label="Uncovered"
              value={report.uncoveredFiles}
              sub="no case targets these"
              tone={report.uncoveredFiles > 0 ? 'warn' : 'neutral'}
            />
            <CoverageStat
              label="Last QA pass"
              value={report.lastDoneAt ? short(report.lastDoneAt) : '—'}
              sub={report.lastDoneAt ? 'most recent done run' : 'no done runs yet'}
              tone="neutral"
              isText
            />
          </div>

          {report.labels.length > 0 ? (
            <div className="coverage-labels">
              <div className="coverage-labels-title">Labels in use</div>
              <div className="coverage-labels-row">
                {report.labels.map((l) => (
                  <span
                    key={l.label}
                    className="pill"
                    title={`${l.caseCount} case${l.caseCount === 1 ? '' : 's'} across ${l.planCount} plan${l.planCount === 1 ? '' : 's'}`}
                  >
                    {l.label} · {l.caseCount}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

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
              <div>File</div>
              <div className="coverage-num">Cases</div>
              <div className="coverage-num">Findings</div>
              <div>Last pass</div>
              <div className="coverage-num">Churn since</div>
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

function CoverageStat({
  label,
  value,
  sub,
  tone,
  isText,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: 'ok' | 'warn' | 'neutral';
  isText?: boolean;
}): ReactElement {
  return (
    <div className={`coverage-stat coverage-stat-${tone ?? 'neutral'}`}>
      <div className="coverage-stat-label">{label}</div>
      <div className={`coverage-stat-value${isText ? ' text' : ''}`}>{value}</div>
      <div className="coverage-stat-sub">{sub}</div>
    </div>
  );
}

function pct(numerator: number, denominator: number): string {
  if (!denominator) return '—';
  return `${Math.round((numerator / denominator) * 100)}%`;
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
