import { describe, it, expect, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent } from '../../src/shared/types';

// Stub the IPC bridge that components touch transitively (via the store).
beforeAll(() => {
  const g = globalThis as unknown as { window?: typeof globalThis };
  g.window = globalThis as typeof globalThis;
  (globalThis as unknown as { window: { obelisk: unknown } }).window.obelisk = {
    invoke: async () => ({ ok: true, value: null }),
    subscribe: () => () => {},
  };
});

describe('SchedulePresetCard renders without crashing', () => {
  it('renders for an agent with no schedule (default-cron)', async () => {
    const { SchedulePresetCard } = await import(
      '../../src/renderer/screens/agents/SchedulePresetCard'
    );
    const agent: Agent = {
      id: 'a1',
      repoId: 'r1',
      name: 'qa-hunter',
      displayName: 'QA Hunter',
      enabled: false,
      runnerOverride: null,
      modelOverride: null,
      scheduleCron: null,
      schedule: null,
      timeoutMs: 600_000,
      permissions: {
        readCode: true,
        runTests: true,
        createIssues: true,
        draftPrs: false,
        merge: false,
      },
      createdAt: new Date().toISOString(),
      multiInstance: true,
      nextFireAt: null,
      lastRunAt: null,
    };
    const html = renderToStaticMarkup(
      createElement(SchedulePresetCard, { agent, onUpdate: async () => {} }),
    );
    expect(html).toContain('Schedule');
    expect(html).toContain('Every 5 min');
    expect(html).toContain('Custom');
  });

  it('renders for an agent with a cron schedule (auto-opens Custom)', async () => {
    const { SchedulePresetCard } = await import(
      '../../src/renderer/screens/agents/SchedulePresetCard'
    );
    const agent: Agent = {
      id: 'a2',
      repoId: 'r1',
      name: 'qa-hunter',
      displayName: 'QA Hunter',
      enabled: true,
      runnerOverride: null,
      modelOverride: null,
      scheduleCron: '0 2 * * *',
      schedule: null,
      timeoutMs: 600_000,
      permissions: {
        readCode: true,
        runTests: true,
        createIssues: true,
        draftPrs: false,
        merge: false,
      },
      createdAt: new Date().toISOString(),
      multiInstance: true,
      nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
      lastRunAt: null,
    };
    const html = renderToStaticMarkup(
      createElement(SchedulePresetCard, { agent, onUpdate: async () => {} }),
    );
    expect(html).toContain('Schedule');
    expect(html).toContain('Trigger mode'); // Custom panel content
  });

  it('renders for an agent with a recurring "hourly" preset', async () => {
    const { SchedulePresetCard } = await import(
      '../../src/renderer/screens/agents/SchedulePresetCard'
    );
    const agent: Agent = {
      id: 'a3',
      repoId: 'r1',
      name: 'bug-fixer',
      displayName: 'Bug Fixer',
      enabled: true,
      runnerOverride: null,
      modelOverride: null,
      scheduleCron: null,
      schedule: {
        mode: 'recurring',
        every: 1,
        unit: 'hour',
        days: [1, 1, 1, 1, 1, 1, 1],
        tz: 'America/Los_Angeles',
      },
      timeoutMs: 600_000,
      permissions: {
        readCode: true,
        runTests: true,
        createIssues: true,
        draftPrs: false,
        merge: false,
      },
      createdAt: new Date().toISOString(),
      multiInstance: true,
      nextFireAt: new Date(Date.now() + 600_000).toISOString(),
      lastRunAt: null,
    };
    const html = renderToStaticMarkup(
      createElement(SchedulePresetCard, { agent, onUpdate: async () => {} }),
    );
    // Hourly should be the active chip (aria-checked="true").
    expect(html).toContain('Hourly');
    expect(html).toMatch(/aria-checked="true"[^>]*>Hourly/);
  });
});
