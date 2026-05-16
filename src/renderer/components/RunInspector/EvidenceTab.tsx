import type { ReactElement } from 'react';
import type { EvidenceItem } from '../../../shared/types';
import { Empty, basename } from './helpers';

export function EvidenceTab({ evidence }: { evidence: EvidenceItem[] }): ReactElement {
  if (evidence.length === 0) return <Empty>No evidence captured yet.</Empty>;
  const groups: Record<string, EvidenceItem[]> = {};
  for (const e of evidence) {
    (groups[e.kind] ??= []).push(e);
  }
  return (
    <div>
      {Object.entries(groups).map(([kind, items]) => (
        <div key={kind} className="mc-evidence-section">
          <div className="mc-evidence-section-title">{kind}</div>
          <ul className="mc-evidence-list">
            {items.map((it) => (
              <li key={it.path}>
                {basename(it.path)} · {it.bytes}b · sha:{it.sha256.slice(0, 10)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
