import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { EmptyState } from '../ui/EmptyState';
import { RunInspector } from '../components/RunInspector';
import { showApiAlert } from '../state/alert-store';
import { showConfirm } from '../state/confirm-store';
import { labelForAgent, humanizeAgo } from '../format';
import { describeTaskRef } from './MissionControl';
import type { Run, RunState, TestPlanSummary } from '../../shared/types';

function stateClassFor(state: RunState): string {
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  return '';
}

/**
 * Archive: the read-only resting place for runs the user cleared from
 * Mission Control. Supports search, click-to-inspect (audit + evidence),
 * Restore back to Mission Control, and Delete permanently.
 */
export function Archive(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const setRoute = useStore((s) => s.setRoute);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [rows, setRows] = useState<Run[]>([]);
  const [query, setQuery] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [planSummaries, setPlanSummaries] = useState<TestPlanSummary[]>([]);

  const planNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of planSummaries) m.set(p.id, p.name);
    return m;
  }, [planSummaries]);

  const refresh = useCallback(
    async (q: string) => {
      if (!repo) return;
      const res = await window.obelisk.invoke('archive:list', {
        repoId: repo.id,
        query: q,
        limit: 200,
      });
      if (res.ok) setRows(res.value);
    },
    [repo],
  );

  // Initial load + plan-name lookups (so "plan:<id>" refs render nicely).
  useEffect(() => {
    if (!repo) return;
    void refresh('');
    void window.obelisk.invoke('testPlans:list', { repoId: repo.id }).then((res) => {
      if (res.ok) setPlanSummaries(res.value);
    });
  }, [repo, refresh]);

  // Debounced search.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void refresh(query);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, refresh]);

  // Live: archive changes (other runs archived elsewhere, or restored) refresh the list.
  useEffect(() => {
    const handler = (): void => {
      void refresh(query);
    };
    window.addEventListener('obelisk:archive-changed', handler);
    return () => window.removeEventListener('obelisk:archive-changed', handler);
  }, [refresh, query]);

  const handleRestore = async (runId: string): Promise<void> => {
    const res = await window.obelisk.invoke('archive:restore', { runId });
    if (!res.ok) {
      showApiAlert(res.error, 'restore run');
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== runId));
    if (selectedRunId === runId) setSelectedRunId(null);
  };

  const handleDeletePermanent = async (runId: string, label: string): Promise<void> => {
    const ok = await showConfirm({
      title: `Delete ${label} permanently?`,
      body: 'The run, audit log, and saved evidence are gone for good.',
      confirmLabel: 'Delete',
      confirmIcon: 'Trash',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await window.obelisk.invoke('runs:delete', { runId });
    if (!res.ok) {
      showApiAlert(res.error, 'delete run');
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== runId));
    if (selectedRunId === runId) setSelectedRunId(null);
  };

  const handleDeleteAll = async (): Promise<void> => {
    if (rows.length === 0 || !repo) return;
    const ok = await showConfirm({
      title: `Delete ${rows.length} archived run${rows.length === 1 ? '' : 's'} permanently?`,
      body: 'Their audit logs and evidence will be removed too.',
      confirmLabel: 'Delete all',
      confirmIcon: 'Trash',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await window.obelisk.invoke('archive:deleteAll', { repoId: repo.id });
    if (!res.ok) {
      showApiAlert(res.error, 'delete all');
      return;
    }
    void refresh(query);
    setSelectedRunId(null);
  };

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="The archive holds runs you've cleared from Mission Control. Connect a repo to populate it."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => setRoute('connect'),
        }}
      />
    );
  }

  const selectedRow = rows.find((r) => r.id === selectedRunId) ?? null;

  return (
    <div className="archive-screen">
      <div className="archive-toolbar">
        <div className="archive-toolbar-left">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setRoute('mission')}
            title="Back to Mission Control"
          >
            <Icon.ArrowLeft size={11} /> Mission Control
          </button>
          <div className="archive-toolbar-title">Archive</div>
          <span className="pill">{rows.length} runs</span>
        </div>
        <div className="archive-toolbar-right">
          <div className="archive-search">
            <span className="archive-search-icon">
              <Icon.Search size={11} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search task, agent, issue#…"
              aria-label="Search archive"
            />
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={handleDeleteAll}
            disabled={rows.length === 0}
            title={rows.length === 0 ? 'Archive is empty' : 'Delete every archived run permanently'}
          >
            <Icon.Trash size={11} /> Delete all permanently
          </button>
        </div>
      </div>

      <div className="archive-body">
        <div className="archive-list">
          {rows.length === 0 ? (
            <div className="archive-empty">
              {query.trim()
                ? 'No archived runs match that search.'
                : 'No archived runs yet. Cleared runs from Mission Control land here.'}
            </div>
          ) : (
            <>
              <div className="archive-header-row">
                <span>Agent</span>
                <span>Task</span>
                <span>State</span>
                <span>Finished</span>
                <span>Archived</span>
                <span style={{ textAlign: 'right' }}>Actions</span>
              </div>
              {rows.map((run) => {
                const { title, subtitle } = describeTaskRef(
                  run.taskRef,
                  run.taskContext,
                  planNames,
                  repo.githubFullName,
                );
                const stateClass = stateClassFor(run.state);
                return (
                  <div
                    key={run.id}
                    role="button"
                    tabIndex={0}
                    className={`archive-row${selectedRunId === run.id ? ' selected' : ''}`}
                    onClick={() => setSelectedRunId(run.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedRunId(run.id);
                      }
                    }}
                  >
                    <span className="archive-agent">{labelForAgent(run.agentName)}</span>
                    <span className="archive-task">
                      <span className="archive-task-title">{title}</span>
                      {subtitle ? <span className="archive-task-sub">{subtitle}</span> : null}
                    </span>
                    <span>
                      <span className={`archive-state-pill ${stateClass}`}>{run.state}</span>
                    </span>
                    <span>{run.finishedAt ? humanizeAgo(run.finishedAt) : '—'}</span>
                    <span>{run.archivedAt ? humanizeAgo(run.archivedAt) : '—'}</span>
                    <span className="archive-actions">
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRestore(run.id);
                        }}
                        title="Move this run back to Mission Control"
                      >
                        <Icon.Restore size={11} /> Restore
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeletePermanent(run.id, title);
                        }}
                        title="Delete this run permanently"
                        aria-label="Delete permanently"
                      >
                        <Icon.Trash size={11} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {selectedRow ? (
          <ArchiveDetail
            run={selectedRow}
            repoFullName={repo.githubFullName}
            onClose={() => setSelectedRunId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ArchiveDetail({
  run,
  repoFullName,
  onClose,
}: {
  run: Run;
  repoFullName: string | null;
  onClose: () => void;
}): ReactElement {
  return (
    <aside className="archive-detail">
      <div className="archive-detail-header">
        <div className="archive-detail-title">{run.taskRef ?? 'Ad-hoc run'}</div>
        <span className={`archive-state-pill ${stateClassFor(run.state)}`}>{run.state}</span>
        <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close">
          <Icon.Close size={11} />
        </button>
      </div>
      <div className="archive-detail-meta">
        <span className="pill">{labelForAgent(run.agentName)}</span>
        <span className="pill">{run.runnerUsed}</span>
        {run.fallbackUsed ? <span className="pill warn">fallback</span> : null}
        {run.errorCode ? <span className="pill bad">{run.errorCode}</span> : null}
        <span className="archive-detail-timeline">
          {run.startedAt ? `Started ${humanizeAgo(run.startedAt)}` : 'Never started'}
          {run.finishedAt ? ` · Finished ${humanizeAgo(run.finishedAt)}` : ''}
          {run.archivedAt ? ` · Archived ${humanizeAgo(run.archivedAt)}` : ''}
        </span>
      </div>
      {run.outputSummary ? <div className="archive-detail-summary">{run.outputSummary}</div> : null}
      <RunInspector run={run} readOnly repoFullName={repoFullName} />
    </aside>
  );
}
