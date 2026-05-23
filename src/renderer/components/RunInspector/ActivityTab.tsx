import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { shortTime } from '../../format';
import type { AuditLine, RunState } from '../../../shared/types';
import {
  buildActivityRows,
  type ActivityRow as ActivityRowData,
} from '../../screens/mission-control-helpers';
import {
  Empty,
  LivePill,
  compactResultMeta,
  firstNonEmpty,
  formatDuration,
  prettyJson,
  previewText,
  shortPath,
  stringOf,
} from './helpers';

/**
 * Activity panel — a Goose-style stack of expandable cards.
 *
 * Each tool call is a bordered card whose chevron reveals input + output;
 * thinking turns render as borderless prose; session start / final result
 * collapse into compact one-line pills. There is no rail and no internal
 * scroll on the content — the panel itself scrolls.
 *
 * For runs that pre-date the structured event format the renderer falls
 * back to re-parsing each persisted stdout line as a stream-json event so
 * old runs surface tool calls and results too.
 */
export function ActivityTab({
  lines,
  runState,
}: {
  lines: AuditLine[];
  runState: RunState;
}): ReactElement {
  const isLive = runState === 'queued' || runState === 'running' || runState === 'publishing';
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => buildActivityRows(lines, showAll), [lines, showAll]);

  return (
    <div className="mc-audit-wrap">
      <div className="mc-audit-header">
        {isLive ? <LivePill /> : <span className="mc-audit-status-idle">Settled</span>}
        <span className="mc-audit-count">
          {rows.length} {rows.length === 1 ? 'step' : 'steps'}
        </span>
        <button
          type="button"
          className="mc-activity-toggle"
          onClick={() => setShowAll((v) => !v)}
          aria-pressed={showAll}
          title={
            showAll
              ? 'Hide low-signal status pings'
              : 'Show every event including heartbeats and legacy log lines'
          }
        >
          {showAll ? 'hide noise' : 'show all'}
        </button>
        <span className="mc-audit-order" title="Most recent at the top">
          newest first
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>{isLive ? 'Waiting for the runner’s first output…' : 'No activity yet.'}</Empty>
      ) : (
        <div className="mc-act-stack">
          {rows.map((row) => (
            <ActivityRow key={row.key} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ row }: { row: ActivityRowData }): ReactElement | null {
  switch (row.kind) {
    case 'sessionInit':
      return <SessionLine row={row} />;
    case 'thinking':
      return <ThinkingCard row={row} />;
    case 'tool':
      return <ToolCard row={row} />;
    case 'event':
      return <EventCard row={row} />;
    case 'result':
      return <ResultLine row={row} />;
    case 'status':
      return <StatusLine row={row} />;
    case 'raw':
      return <RawLine row={row} />;
  }
}

function SessionLine({
  row,
}: {
  row: Extract<ActivityRowData, { kind: 'sessionInit' }>;
}): ReactElement {
  const bits: string[] = [];
  if (row.model) bits.push(row.model);
  if (typeof row.toolCount === 'number') bits.push(`${row.toolCount} tools`);
  if (row.cwd) bits.push(shortPath(row.cwd));
  return (
    <div className="mc-act-pill" role="listitem">
      <span className="mc-act-pill-icon" aria-hidden="true">
        <Icon.Sparkles size={11} color="var(--t-3)" />
      </span>
      <span className="mc-act-pill-time">{shortTime(row.at)}</span>
      <span className="mc-act-pill-text">Session started</span>
      {bits.length > 0 ? <span className="mc-act-pill-meta">{bits.join(' · ')}</span> : null}
    </div>
  );
}

function ResultLine({ row }: { row: Extract<ActivityRowData, { kind: 'result' }> }): ReactElement {
  const bits: string[] = [];
  if (typeof row.turns === 'number') bits.push(`${row.turns} turns`);
  if (typeof row.durationMs === 'number') bits.push(formatDuration(row.durationMs));
  if (typeof row.costUsd === 'number') bits.push(`$${row.costUsd.toFixed(2)}`);
  return (
    <div className={`mc-act-pill is-result ${row.ok ? 'tone-ok' : 'tone-bad'}`} role="listitem">
      <span className="mc-act-pill-icon" aria-hidden="true">
        {row.ok ? (
          <Icon.Check size={11} color="var(--ok)" />
        ) : (
          <Icon.Close size={11} color="var(--bad)" />
        )}
      </span>
      <span className="mc-act-pill-time">{shortTime(row.at)}</span>
      <span className="mc-act-pill-text">{row.ok ? 'Run complete' : 'Run failed'}</span>
      {bits.length > 0 ? <span className="mc-act-pill-meta">{bits.join(' · ')}</span> : null}
    </div>
  );
}

/**
 * Thinking turn — renders with the same card chrome as ToolCard so the
 * timeline reads as a uniform stack. Short turns (≤2 lines, ≤160 chars)
 * render flat with the full text inline (no expand affordance, since
 * there is nothing more to reveal). Longer turns collapse so a giant
 * reasoning dump doesn't push everything else off the screen, with the
 * full text behind the chevron.
 */
function ThinkingCard({
  row,
}: {
  row: Extract<ActivityRowData, { kind: 'thinking' }>;
}): ReactElement {
  const lines = row.text.split('\n');
  const lineCount = lines.length;
  const charCount = row.text.length;
  const short = lineCount <= 2 && charCount <= 160;
  const [expanded, setExpanded] = useState(false);
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim() ?? '';

  if (short) {
    return (
      <div className="mc-act-tool tone-muted" role="listitem">
        <div className="mc-act-tool-head is-static">
          <span className="mc-act-tool-icon" aria-hidden="true">
            <Icon.Spark size={12} color="var(--t-2)" />
            <span className="mc-act-pip tone-info" />
          </span>
          <span className="mc-act-tool-time">{shortTime(row.at)}</span>
          <span className="mc-act-tool-title">
            <span className="mc-act-tool-verb">thinking</span>
            <span className="mc-act-tool-target is-prose">{row.text.trim()}</span>
          </span>
          <span className="mc-act-tool-meta" />
        </div>
      </div>
    );
  }

  return (
    <div className={`mc-act-tool tone-muted${expanded ? ' is-expanded' : ''}`} role="listitem">
      <button
        type="button"
        className="mc-act-tool-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="mc-act-tool-icon" aria-hidden="true">
          <Icon.Spark size={12} color="var(--t-2)" />
          <span className="mc-act-pip tone-info" />
        </span>
        <span className="mc-act-tool-time">{shortTime(row.at)}</span>
        <span className="mc-act-tool-title">
          <span className="mc-act-tool-verb">thinking</span>
          {!expanded && firstLine ? (
            <span className="mc-act-tool-target is-prose">{previewText(firstLine, 70)}</span>
          ) : null}
        </span>
        <span className="mc-act-tool-meta">{lineCount} lines</span>
        <Icon.Chevron
          size={11}
          color="var(--t-3)"
          style={{
            marginLeft: 4,
            transform: expanded ? 'rotate(90deg)' : undefined,
            transition: 'transform .12s ease',
          }}
        />
      </button>
      {expanded ? (
        <div className="mc-act-tool-body">
          <div className="mc-act-tool-section">
            <div className="mc-act-tool-section-body">
              <div className="mc-act-prose">{row.text}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EventCard({ row }: { row: Extract<ActivityRowData, { kind: 'event' }> }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const lineCount = row.content.split('\n').length;
  const meta = lineCount === 1 ? `${row.content.length} chars` : `${lineCount} lines`;
  return (
    <div className={`mc-act-tool tone-muted${expanded ? ' is-expanded' : ''}`} role="listitem">
      <button
        type="button"
        className="mc-act-tool-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="mc-act-tool-icon" aria-hidden="true">
          <Icon.Sliders size={12} color="var(--t-2)" />
          <span className="mc-act-pip tone-pending" />
        </span>
        <span className="mc-act-tool-time">{shortTime(row.at)}</span>
        <span className="mc-act-tool-title">
          <span className="mc-act-tool-verb">{row.subtype}</span>
          <span className="mc-act-tool-target">unparseable</span>
        </span>
        <span className="mc-act-tool-meta">{meta}</span>
        <Icon.Chevron
          size={11}
          color="var(--t-3)"
          style={{
            marginLeft: 4,
            transform: expanded ? 'rotate(90deg)' : undefined,
            transition: 'transform .12s ease',
          }}
        />
      </button>
      {expanded ? (
        <div className="mc-act-tool-body">
          <div className="mc-act-tool-section">
            <div className="mc-act-tool-section-body">
              <pre className="mc-act-pre">{row.content}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({ row }: { row: Extract<ActivityRowData, { kind: 'tool' }> }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const desc = describeToolCall(row.name, row.input);
  const status: ToolStatus = row.result ? (row.result.ok ? 'ok' : 'bad') : 'pending';
  return (
    <div className={`mc-act-tool tone-${status}${expanded ? ' is-expanded' : ''}`} role="listitem">
      <button
        type="button"
        className="mc-act-tool-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="mc-act-tool-icon" aria-hidden="true">
          {desc.icon}
          <span className={`mc-act-pip tone-${status}`} />
        </span>
        <span className="mc-act-tool-time">{shortTime(row.at)}</span>
        <span className="mc-act-tool-title">
          <span className="mc-act-tool-verb">{desc.verb}</span>
          {desc.target ? <span className="mc-act-tool-target">{desc.target}</span> : null}
        </span>
        {row.result && row.result.ok ? (
          <span className="mc-act-tool-meta">{compactResultMeta(row.result.content)}</span>
        ) : null}
        {row.result && !row.result.ok ? (
          <span className="mc-act-tool-meta is-bad">
            {previewText(firstNonEmpty(row.result.content) || 'error', 50)}
          </span>
        ) : null}
        {!row.result ? <span className="mc-act-tool-meta is-pending">running…</span> : null}
        <Icon.Chevron
          size={11}
          color="var(--t-3)"
          style={{
            marginLeft: 4,
            transform: expanded ? 'rotate(90deg)' : undefined,
            transition: 'transform .12s ease',
          }}
        />
      </button>
      {expanded ? (
        <div className="mc-act-tool-body">
          <ToolSection
            label={describeInputLabel(row.name)}
            body={renderInput(row.name, row.input)}
          />
          {row.result ? (
            <ToolSection
              label={row.result.ok ? 'Output' : 'Error'}
              tone={row.result.ok ? undefined : 'bad'}
              body={
                row.result.content.length === 0 ? (
                  <span className="mc-act-empty">(no output)</span>
                ) : (
                  <pre className="mc-act-pre">{row.result.content}</pre>
                )
              }
            />
          ) : (
            <ToolSection label="Output" body={<span className="mc-act-empty">running…</span>} />
          )}
        </div>
      ) : null}
    </div>
  );
}

type ToolStatus = 'ok' | 'bad' | 'pending';

function ToolSection({
  label,
  body,
  tone,
}: {
  label: string;
  body: ReactNode;
  tone?: 'bad';
}): ReactElement {
  return (
    <section className={`mc-act-tool-section${tone === 'bad' ? ' is-bad' : ''}`}>
      <div className="mc-act-tool-section-label">{label}</div>
      <div className="mc-act-tool-section-body">{body}</div>
    </section>
  );
}

function StatusLine({ row }: { row: Extract<ActivityRowData, { kind: 'status' }> }): ReactElement {
  return (
    <div className="mc-act-status-line" role="listitem">
      <Icon.Dot size={11} color="var(--t-3)" />
      <span className="mc-act-pill-time">{shortTime(row.at)}</span>
      <span className="mc-act-pill-text">{row.subtype}</span>
    </div>
  );
}

function RawLine({ row }: { row: Extract<ActivityRowData, { kind: 'raw' }> }): ReactElement {
  return (
    <div className={`mc-act-raw-line is-${row.stream}`} role="listitem">
      <span className="mc-act-raw-time">{shortTime(row.at)}</span>
      <span className={`mc-act-raw-stream is-${row.stream}`}>{row.stream}</span>
      <span className="mc-act-raw-text">{row.text}</span>
    </div>
  );
}

interface ToolDescriptor {
  icon: ReactNode;
  verb: string;
  target: string | null;
}

function describeToolCall(name: string, input: unknown): ToolDescriptor {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = stringOf(i['file_path']) ?? stringOf(i['path']);
  switch (name) {
    case 'Read':
      return {
        icon: <Icon.Doc size={12} color="var(--t-2)" />,
        verb: 'reading',
        target: path ? shortPath(path) : null,
      };
    case 'Edit':
      return {
        icon: <Icon.Code size={12} color="var(--t-2)" />,
        verb: 'editing',
        target: path ? shortPath(path) : null,
      };
    case 'MultiEdit':
      return {
        icon: <Icon.Code size={12} color="var(--t-2)" />,
        verb: 'editing',
        target: path ? shortPath(path) : null,
      };
    case 'Write':
      return {
        icon: <Icon.Code size={12} color="var(--t-2)" />,
        verb: 'writing',
        target: path ? shortPath(path) : null,
      };
    case 'Bash': {
      const cmd = stringOf(i['command']);
      return {
        icon: <Icon.Terminal size={12} color="var(--t-2)" />,
        verb: 'running',
        target: cmd ? previewText(cmd, 60) : null,
      };
    }
    case 'Grep':
    case 'Glob':
    case 'Search': {
      const q = stringOf(i['pattern']) ?? stringOf(i['query']);
      return {
        icon: <Icon.Search size={12} color="var(--t-2)" />,
        verb: 'searching',
        target: q ?? null,
      };
    }
    case 'TodoWrite':
      return {
        icon: <Icon.Filter size={12} color="var(--t-2)" />,
        verb: 'updating plan',
        target: null,
      };
    case 'Task':
      return {
        icon: <Icon.Agents size={12} color="var(--t-2)" />,
        verb: 'sub-agent',
        target: stringOf(i['description']) ?? null,
      };
    case 'WebFetch':
    case 'WebSearch':
      return {
        icon: <Icon.Search size={12} color="var(--t-2)" />,
        verb: 'web',
        target: stringOf(i['url']) ?? stringOf(i['query']) ?? null,
      };
    default:
      return {
        icon: <Icon.Sliders size={12} color="var(--t-2)" />,
        verb: name || 'tool',
        target: null,
      };
  }
}

function describeInputLabel(name: string): string {
  if (name === 'Bash') return 'Command';
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit')
    return 'Arguments';
  return 'Input';
}

function renderInput(name: string, input: unknown): ReactNode {
  if (name === 'Bash') {
    const i = (input ?? {}) as Record<string, unknown>;
    const cmd = stringOf(i['command']) ?? '';
    return <pre className="mc-act-pre">{cmd}</pre>;
  }
  return <pre className="mc-act-pre">{prettyJson(input)}</pre>;
}
