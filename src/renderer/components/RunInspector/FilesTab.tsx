import type { ReactElement } from 'react';
import type { EvidenceItem } from '../../../shared/types';
import { Empty, basename } from './helpers';

export function FilesTab({ evidence }: { evidence: EvidenceItem[] }): ReactElement {
  const patches = evidence.filter((e) => e.kind === 'patch' || e.kind === 'failing_test_diff');
  if (patches.length === 0) return <Empty>No patch artifacts yet.</Empty>;
  return (
    <ul className="mc-files-list">
      {patches.map((p) => (
        <li key={p.path}>
          {basename(p.path)} ({p.bytes} bytes)
        </li>
      ))}
    </ul>
  );
}
