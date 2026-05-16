import { useState, type ReactElement } from 'react';
import type { PreviewedFinding } from '../../../shared/types';
import { FindingPreview } from '../FindingPreview';
import { Empty } from './helpers';

export function FindingsTab({
  findings,
  onOpen,
  onDismiss,
  onUndismiss,
  readOnly = false,
}: {
  findings: PreviewedFinding[];
  onOpen: (f: PreviewedFinding) => void;
  onDismiss?: (f: PreviewedFinding) => void;
  onUndismiss?: (f: PreviewedFinding) => void;
  readOnly?: boolean;
}): ReactElement {
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissedCount = findings.filter((f) => f.dismissed).length;
  const visible = showDismissed ? findings : findings.filter((f) => !f.dismissed);

  if (visible.length === 0 && dismissedCount === 0) {
    return <Empty>No findings to review.</Empty>;
  }

  return (
    <div className="mc-findings col gap-1">
      {dismissedCount > 0 ? (
        <button
          type="button"
          className="btn ghost sm mc-findings-toggle"
          onClick={() => setShowDismissed((v) => !v)}
        >
          {showDismissed
            ? `Hide dismissed (${dismissedCount})`
            : `Show dismissed (${dismissedCount})`}
        </button>
      ) : null}
      {visible.length === 0 ? (
        <Empty>No findings to review.</Empty>
      ) : (
        visible.map((f) => (
          <FindingPreview
            key={f.id}
            finding={f}
            onOpen={onOpen}
            {...(readOnly ? {} : { onDismiss, onUndismiss })}
            readOnly={readOnly}
          />
        ))
      )}
    </div>
  );
}
