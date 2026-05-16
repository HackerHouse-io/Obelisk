import type { ReactElement } from 'react';
import type { AuditLine } from '../../../shared/types';
import { Empty } from './helpers';

export function ReasoningTab({ lines }: { lines: AuditLine[] }): ReactElement {
  const reasoningLines = lines.filter((l) => l.kind === 'reasoning' || l.kind === 'evidence_check');
  if (reasoningLines.length === 0) return <Empty>No reasoning entries yet.</Empty>;
  return (
    <div className="col gap-2">
      {reasoningLines.map((l) => (
        <div key={l.id}>
          <div className="mc-evidence-section-title">{l.kind}</div>
          <pre className="mc-pre-payload">{JSON.stringify(l.payload, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
