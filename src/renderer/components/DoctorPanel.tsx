import { useState, type ReactElement } from 'react';
import type { DoctorReport } from '../../shared/types';

interface Props {
  report: DoctorReport | null;
  onCheck: () => Promise<void>;
  onSetup: () => Promise<void>;
  busy: boolean;
}

export function DoctorPanel({ report, onCheck, onSetup, busy }: Props): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const overall = report?.overall ?? 'red';
  const isGreen = overall === 'green';

  if (collapsed && isGreen) {
    return (
      <div className="card row gap-2" style={{ padding: 8, alignItems: 'center' }}>
        <span className="dot" style={{ background: 'var(--ok)' }} />
        <span style={{ fontSize: 12, color: 'var(--t-2)' }}>iOS QA Pilot setup is healthy.</span>
        <button type="button" className="btn ghost sm" onClick={() => setCollapsed(false)}>
          Show details
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="row gap-2" style={{ alignItems: 'center' }}>
          <span
            className="dot"
            style={{
              background: levelColor(overall),
              boxShadow: `0 0 0 4px ${levelColor(overall)}22`,
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {isGreen ? 'Setup healthy' : overall === 'yellow' ? 'Setup degraded' : 'Setup required'}
          </span>
          {report?.setupAt ? (
            <span style={{ fontSize: 11, color: 'var(--t-3)' }}>
              · last setup {timeAgo(report.setupAt)}
            </span>
          ) : null}
        </div>
        <div className="row gap-2">
          <button type="button" className="btn ghost sm" onClick={onCheck} disabled={busy}>
            Re-check
          </button>
          {!isGreen ? (
            <button type="button" className="btn primary sm" onClick={onSetup} disabled={busy}>
              {busy ? 'Running setup…' : 'Run setup'}
            </button>
          ) : null}
          {isGreen ? (
            <button type="button" className="btn ghost sm" onClick={() => setCollapsed(true)}>
              Hide
            </button>
          ) : null}
        </div>
      </div>

      {report ? (
        <div className="col" style={{ marginTop: 10, gap: 6 }}>
          {report.checks.map((c) => (
            <div
              key={c.id}
              className="row gap-2"
              style={{
                padding: '6px 8px',
                background: 'var(--bg-1)',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <span className="dot" style={{ background: levelColor(c.level), marginTop: 4 }} />
              <div className="col" style={{ gap: 2, flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{c.label}</div>
                <div style={{ color: 'var(--t-2)' }}>{c.detail}</div>
                {c.remediation && c.level !== 'green' ? (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--t-3)' }}>
                    {c.remediation}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--t-3)' }}>
          No diagnostics yet — click <em>Re-check</em>.
        </div>
      )}
    </div>
  );
}

function levelColor(level: 'green' | 'yellow' | 'red'): string {
  if (level === 'green') return 'var(--ok)';
  if (level === 'yellow') return 'var(--warn)';
  return 'var(--bad)';
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
