import { describe, it, expect, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AuditLine } from '../../src/shared/types';

beforeAll(() => {
  const g = globalThis as unknown as { window?: typeof globalThis };
  g.window = globalThis as typeof globalThis;
  (globalThis as unknown as { window: { obelisk: unknown } }).window.obelisk = {
    invoke: async () => ({ ok: true, value: null }),
    subscribe: () => () => {},
  };
});

// A run that failed before the runner emitted any tool calls only has
// kind:'state' audit rows, which the activity timeline filters out — so it
// renders with zero visible steps. It must still show WHY it failed.
const stateOnly: AuditLine[] = [
  { id: 1, runId: 'r', at: '2026-05-28T20:00:00.000Z', kind: 'state', payload: { from: 'queued', to: 'running' } },
  { id: 2, runId: 'r', at: '2026-05-28T20:10:00.000Z', kind: 'state', payload: { from: 'running', to: 'failed', reason: 'timeout' } },
];

async function render(props: {
  lines: AuditLine[];
  runState: import('../../src/shared/types').RunState;
  errorCode?: string | null;
  outputSummary?: string | null;
}): Promise<string> {
  const { ActivityTab } = await import('../../src/renderer/components/RunInspector/ActivityTab');
  return renderToStaticMarkup(createElement(ActivityTab, props));
}

describe('ActivityTab failure card', () => {
  it('shows the failure reason instead of "No activity yet" when a failed run has no visible steps', async () => {
    const html = await render({
      lines: stateOnly,
      runState: 'failed',
      errorCode: 'TIMEOUT',
      outputSummary: '> 600000ms',
    });
    expect(html).toContain('Run failed');
    expect(html).toContain('TIMEOUT');
    expect(html).toContain('&gt; 600000ms');
    expect(html).not.toContain('No activity yet');
  });

  it('falls back to a generic explanation when no error detail was recorded', async () => {
    const html = await render({ lines: stateOnly, runState: 'failed', errorCode: null, outputSummary: null });
    expect(html).toContain('Run failed');
    expect(html).toContain('failed before producing any activity');
    expect(html).not.toContain('No activity yet');
  });

  it('keeps the live "waiting" copy for an in-flight run with no output yet', async () => {
    const html = await render({ lines: [], runState: 'running' });
    expect(html).toContain('Waiting for the runner');
    expect(html).not.toContain('Run failed');
  });

  it('does not show the failure card for a settled run that is not failed', async () => {
    const html = await render({ lines: [], runState: 'done' });
    expect(html).toContain('No activity yet');
    expect(html).not.toContain('Run failed');
  });
});
