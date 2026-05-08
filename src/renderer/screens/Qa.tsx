import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { EmptyState } from '../ui/EmptyState';
import { DoctorPanel } from '../components/DoctorPanel';
import type { DoctorReport, QaFlow, QaFlowStatus } from '../../shared/types';

export function Qa(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [flows, setFlows] = useState<QaFlow[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupStep, setSetupStep] = useState<string | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshFlows = useCallback(async () => {
    if (!repo) return;
    const res = await window.obelisk.invoke('qa:list', { repoId: repo.id });
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setFlows(res.value);
    if (!selectedFlowId && res.value.length > 0) {
      setSelectedFlowId(res.value[0]!.flowId);
    }
  }, [repo, selectedFlowId]);

  const refreshDoctor = useCallback(async () => {
    if (!repo) return;
    setBusy(true);
    const res = await window.obelisk.invoke('qa:doctor', { repoId: repo.id });
    setBusy(false);
    if (res.ok) setDoctor(res.value);
    else setError(res.error.message);
  }, [repo]);

  useEffect(() => {
    void refreshFlows();
    void refreshDoctor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  useEffect(() => {
    const unsubscribe = window.obelisk.subscribe((evt) => {
      if (evt.type === 'qa.flowChanged' && evt.repoId === repo?.id) void refreshFlows();
      if (evt.type === 'qa.doctorChanged' && evt.repoId === repo?.id) void refreshDoctor();
      if (evt.type === 'qa.doctorProgress' && evt.repoId === repo?.id) {
        setSetupStep(evt.status === 'started' ? evt.label : null);
      }
      if (evt.type === 'run.transition') void refreshFlows();
    });
    return unsubscribe;
  }, [repo?.id, refreshFlows, refreshDoctor]);

  const selectedFlow = useMemo(
    () => flows.find((f) => f.flowId === selectedFlowId) ?? null,
    [flows, selectedFlowId],
  );

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="iOS QA Pilot runs against an iOS app in a connected repo."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }

  const doctorGreen = doctor?.overall === 'green';

  async function runSetup(): Promise<void> {
    if (!repo) return;
    setBusy(true);
    setSetupStep(null);
    setError(null);
    const res = await window.obelisk.invoke('qa:doctorSetup', { repoId: repo.id });
    setBusy(false);
    setSetupStep(null);
    if (res.ok) setDoctor(res.value);
    else setError(res.error.message);
  }

  async function runAll(): Promise<void> {
    if (!repo) return;
    setError(null);
    const res = await window.obelisk.invoke('qa:plan', { repoId: repo.id });
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    if (res.value.enqueued === 0) {
      setError(res.value.reason ?? 'Nothing to run.');
    }
    void refreshFlows();
  }

  async function runSelected(): Promise<void> {
    if (!repo || !selectedFlowId) return;
    setError(null);
    const res = await window.obelisk.invoke('qa:runFlow', {
      repoId: repo.id,
      flowId: selectedFlowId,
    });
    if (!res.ok) setError(res.error.message);
    void refreshFlows();
  }

  async function reset(scope: 'unverified' | 'all'): Promise<void> {
    if (!repo) return;
    if (
      !confirm(
        scope === 'all'
          ? 'Reset ALL flows including any currently running? Running runs continue but their writes are dropped.'
          : 'Reset all unverified flows? Running flows continue and may write back results.',
      )
    )
      return;
    const res = await window.obelisk.invoke('qa:reset', { repoId: repo.id, scope });
    if (!res.ok) setError(res.error.message);
    void refreshFlows();
  }

  return (
    <div className="col" style={{ gap: 12, padding: 16, height: '100%', overflow: 'auto' }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="row gap-2" style={{ alignItems: 'center' }}>
          <Icon.Phone size={16} color="var(--brand)" />
          <span style={{ fontSize: 16, fontWeight: 600 }}>iOS QA Pilot</span>
          <span style={{ fontSize: 12, color: 'var(--t-3)' }}>
            {flows.length} {flows.length === 1 ? 'flow' : 'flows'}
          </span>
        </div>
        <div className="row gap-2">
          <button
            type="button"
            className="btn primary sm"
            onClick={runAll}
            disabled={!doctorGreen || flows.length === 0}
            title={!doctorGreen ? 'Doctor must be green to run' : undefined}
          >
            Run all
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={runSelected}
            disabled={!doctorGreen || !selectedFlowId}
          >
            Run selected
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={(e) => reset(e.shiftKey ? 'all' : 'unverified')}
            disabled={flows.length === 0}
            title="Shift+click to also reset running flows"
          >
            Reset progress
          </button>
        </div>
      </div>

      <DoctorPanel
        report={doctor}
        onCheck={refreshDoctor}
        onSetup={runSetup}
        busy={busy}
        setupStep={setupStep}
      />

      {error ? (
        <div
          className="card"
          style={{ padding: 8, fontSize: 12, color: 'var(--bad)', borderColor: 'var(--bad)' }}
        >
          {error}
        </div>
      ) : null}

      {flows.length === 0 ? (
        <EmptyState
          title="No iOS flows yet"
          body={
            <>
              Add a <span className="mono">qa/ios.yml</span> with{' '}
              <span className="mono">app_path</span> + <span className="mono">bundle_id</span>, then
              create flow files at <span className="mono">qa/ios-flows/*.flow.md</span>. Obelisk
              will pick them up on the next run.
            </>
          }
        />
      ) : (
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flex: 1 }}>
          <div className="col" style={{ gap: 4, flex: '0 0 360px' }}>
            {flows.map((f) => (
              <button
                key={f.flowId}
                type="button"
                onClick={() => setSelectedFlowId(f.flowId)}
                className={`card hover-lift${selectedFlowId === f.flowId ? ' selected' : ''}`}
                style={{
                  padding: 8,
                  textAlign: 'left',
                  borderColor: selectedFlowId === f.flowId ? 'var(--brand)' : undefined,
                }}
              >
                <div className="row gap-2" style={{ alignItems: 'center' }}>
                  <StatusPill status={f.status} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</span>
                </div>
                <div className="mono" style={{ marginTop: 4, fontSize: 11, color: 'var(--t-3)' }}>
                  {f.sourcePath}
                </div>
              </button>
            ))}
          </div>

          <div className="card col" style={{ padding: 16, gap: 8, flex: 1 }}>
            {selectedFlow ? (
              <FlowDetail flow={selectedFlow} />
            ) : (
              <div style={{ color: 'var(--t-3)', fontSize: 12 }}>Select a flow.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: QaFlowStatus }): ReactElement {
  const map: Record<QaFlowStatus, { cls: string; label: string }> = {
    pending: { cls: '', label: 'Pending' },
    running: { cls: 'info', label: 'Running' },
    passed: { cls: 'ok', label: 'Passed' },
    failed: { cls: 'bad', label: 'Failed' },
    inconclusive: { cls: 'warn', label: 'Inconclusive' },
    outdated: { cls: 'warn', label: 'Outdated' },
  };
  const { cls, label } = map[status];
  return <span className={`pill${cls ? ' ' + cls : ''}`}>{label}</span>;
}

function FlowDetail({ flow }: { flow: QaFlow }): ReactElement {
  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{flow.title}</span>
        <StatusPill status={flow.status} />
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--t-3)' }}>
        {flow.sourcePath}
      </div>
      {flow.renamedFromOldId ? (
        <div style={{ fontSize: 11, color: 'var(--t-3)' }}>
          Renamed from <span className="mono">{flow.renamedFromOldId}</span>
        </div>
      ) : null}
      <div className="row gap-2" style={{ marginTop: 6, fontSize: 12, color: 'var(--t-2)' }}>
        <span>Cycle {flow.cycle}</span>
        {flow.lastVerifiedAt ? <span>· Last verified {timeAgo(flow.lastVerifiedAt)}</span> : null}
        <span>
          · {flow.findingCount} {flow.findingCount === 1 ? 'finding' : 'findings'}
        </span>
      </div>
      {flow.lastRunId ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          Last run:{' '}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => useStore.getState().setRoute('mission')}
          >
            Open in Mission Control
          </button>
        </div>
      ) : null}
    </>
  );
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
