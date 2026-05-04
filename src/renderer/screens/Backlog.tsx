import { useEffect, useMemo, useState, type DragEvent, type ReactElement } from 'react';
import { Icon } from '../icons';
import { useStore } from '../state/store';
import { runAgentByName } from '../state/agent-actions';
import type { AgentName, BacklogItem } from '../../shared/types';
import { EmptyState } from '../ui/EmptyState';

type Filter = 'all' | 'bug' | 'feature';

export function Backlog(): ReactElement {
  const repos = useStore((s) => s.repos);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId);

  const [items, setItems] = useState<BacklogItem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const refetch = async (): Promise<void> => {
    if (!repo) return;
    const res = await window.obelisk.invoke('backlog:list', { repoId: repo.id });
    if (res.ok) setItems(res.value);
  };

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  const visible = useMemo(
    () => items.filter((i) => filter === 'all' || i.kind === filter),
    [items, filter],
  );
  const nextUp = visible.slice(0, 6);
  const later = visible.slice(6);

  if (!repo) {
    return (
      <EmptyState
        title="No repo connected"
        body="Connect a repo to populate the backlog."
        action={{
          label: 'Connect a repo',
          icon: <Icon.Connect size={13} />,
          onClick: () => useStore.getState().setRoute('connect'),
        }}
      />
    );
  }

  function onDragStart(id: string): (e: DragEvent<HTMLDivElement>) => void {
    return (e) => {
      setDraggingId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    };
  }

  function onDragOver(id: string): (e: DragEvent<HTMLDivElement>) => void {
    return (e) => {
      e.preventDefault();
      if (draggingId && draggingId !== id) setDropTargetId(id);
      e.dataTransfer.dropEffect = 'move';
    };
  }

  function onDragLeave(): void {
    setDropTargetId(null);
  }

  function onDrop(targetId: string): (e: DragEvent<HTMLDivElement>) => void {
    return async (e) => {
      e.preventDefault();
      const sourceId = draggingId ?? e.dataTransfer.getData('text/plain');
      setDropTargetId(null);
      setDraggingId(null);
      if (!sourceId || sourceId === targetId) return;
      const reordered = reorder(items, sourceId, targetId);
      setItems(reordered); // optimistic
      const res = await window.obelisk.invoke('backlog:reorder', {
        repoId: repo!.id,
        orderedIds: reordered.map((i) => i.id),
      });
      if (!res.ok) await refetch(); // revert on failure
    };
  }

  async function runFixerForKind(kind: BacklogItem['kind']): Promise<void> {
    const agentName: AgentName = kind === 'bug' ? 'bug-fixer' : 'feature-builder';
    const res = await runAgentByName(repo!.id, agentName);
    if (!res.ok) alert(res.error.message);
  }

  async function pin(itemId: string): Promise<void> {
    // Move the item to position 1 via the existing reorder endpoint.
    const moved = items.filter((i) => i.id === itemId);
    const rest = items.filter((i) => i.id !== itemId);
    const next = [...moved, ...rest];
    setItems(next);
    const res = await window.obelisk.invoke('backlog:reorder', {
      repoId: repo!.id,
      orderedIds: next.map((i) => i.id),
    });
    if (!res.ok) await refetch();
  }

  return (
    <div className="backlog">
      <div className="backlog-header">
        <div className="backlog-title-row">
          <div>
            <div className="backlog-title">Backlog</div>
            <div className="backlog-sub">
              Drag to reorder. The top item is the next thing Bug Fixer or Feature Builder picks up.
            </div>
          </div>
          <button type="button" className="btn primary" onClick={() => runFixerForKind('bug')}>
            <Icon.Play size={11} /> Send top to fixer now
          </button>
        </div>
        <div className="backlog-filters">
          {(['all', 'bug', 'feature'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn sm${filter === f ? ' primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'bug' ? 'Bugs' : 'Features'}
            </button>
          ))}
          <span className="muted" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 11 }}>
            {visible.length} {visible.length === 1 ? 'item' : 'items'}
          </span>
        </div>
      </div>

      <div className="backlog-body">
        {visible.length === 0 ? (
          <div className="home-table-empty">
            Backlog is empty. QA Hunter and Manual QA fill this on their next run.
          </div>
        ) : (
          <>
            <div>
              <div className="backlog-section-title">
                <span className="dot" style={{ background: 'var(--brand)' }} />
                Next up
              </div>
              <div className="backlog-list">
                {nextUp.map((item, i) => (
                  <Row
                    key={item.id}
                    item={item}
                    position={i + 1}
                    later={false}
                    isDragging={draggingId === item.id}
                    isDropTarget={dropTargetId === item.id}
                    onDragStart={onDragStart(item.id)}
                    onDragOver={onDragOver(item.id)}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop(item.id)}
                    onPin={() => pin(item.id)}
                    onRunNow={() => runFixerForKind(item.kind)}
                  />
                ))}
              </div>
            </div>
            {later.length > 0 ? (
              <div>
                <div className="backlog-section-title">
                  <span className="dot" style={{ background: 'var(--t-3)' }} />
                  Later
                </div>
                <div className="backlog-list">
                  {later.map((item, i) => (
                    <Row
                      key={item.id}
                      item={item}
                      position={i + 7}
                      later={true}
                      isDragging={draggingId === item.id}
                      isDropTarget={dropTargetId === item.id}
                      onDragStart={onDragStart(item.id)}
                      onDragOver={onDragOver(item.id)}
                      onDragLeave={onDragLeave}
                      onDrop={onDrop(item.id)}
                      onPin={() => pin(item.id)}
                      onRunNow={() => runFixerForKind(item.kind)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  item: BacklogItem;
  position: number;
  later: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPin: () => void;
  onRunNow: () => void;
}

function Row({
  item,
  position,
  later,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onPin,
  onRunNow,
}: RowProps): ReactElement {
  const cls = [
    'backlog-row',
    later ? 'later' : '',
    isDragging ? 'dragging' : '',
    isDropTarget ? 'drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="backlog-handle" title="Drag to reorder">
        <Icon.Drag size={14} />
      </div>
      <div className="backlog-position">{position}</div>
      <div className="backlog-pin">
        <button
          type="button"
          className={`backlog-pin-button${item.userPinRank === 1 ? ' active' : ''}`}
          title={item.userPinRank === 1 ? 'Pinned' : 'Pin to top'}
          onClick={onPin}
        >
          <Icon.Pin size={12} />
        </button>
      </div>
      <span className={`pill${priorityTone(item.priorityLabel)}`}>{item.priorityLabel ?? '—'}</span>
      <span className="backlog-kind-icon" title={item.kind}>
        {item.kind === 'bug' ? (
          <Icon.Bug size={13} color="var(--bad)" />
        ) : (
          <Icon.Sparkles size={13} color="var(--brand)" />
        )}
      </span>
      <div className="backlog-title-cell">
        <span className="backlog-issue">
          {item.githubIssue ? `#${item.githubIssue}` : 'manual'}
        </span>
        <span className="backlog-title-text truncate">{item.title}</span>
      </div>
      <span className="backlog-agent">→ {agentForKind(item.kind, item.agentOverride)}</span>
      <div className="backlog-row-actions">
        <button
          type="button"
          className="btn icon sm"
          title={`Run ${agentForKind(item.kind, item.agentOverride)} now`}
          onClick={onRunNow}
        >
          <Icon.Play size={11} />
        </button>
      </div>
    </div>
  );
}

function priorityTone(p: BacklogItem['priorityLabel']): string {
  if (p === 'P0') return ' bad';
  if (p === 'P1') return ' warn';
  return '';
}

function agentForKind(kind: BacklogItem['kind'], override: AgentName | null): string {
  if (override) return override;
  return kind === 'bug' ? 'bug-fixer' : 'feature-builder';
}

function reorder(items: BacklogItem[], sourceId: string, targetId: string): BacklogItem[] {
  const sourceIdx = items.findIndex((i) => i.id === sourceId);
  const targetIdx = items.findIndex((i) => i.id === targetId);
  if (sourceIdx < 0 || targetIdx < 0) return items;
  const next = [...items];
  const [moved] = next.splice(sourceIdx, 1);
  if (!moved) return items;
  next.splice(targetIdx, 0, moved);
  return next;
}
