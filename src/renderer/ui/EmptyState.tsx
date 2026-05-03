import type { ReactElement, ReactNode } from 'react';

interface Props {
  title: string;
  body?: ReactNode;
  action?: { label: string; icon?: ReactNode; onClick: () => void };
}

export function EmptyState({ title, body, action }: Props): ReactElement {
  return (
    <div className="placeholder">
      <div className="placeholder-title">{title}</div>
      {body ? <div className="placeholder-body">{body}</div> : null}
      {action ? (
        <div className="placeholder-actions">
          <button type="button" className="btn primary lg" onClick={action.onClick}>
            {action.icon}
            {action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
