import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkeleton } from '../../src/main/test-plans/heuristic';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'obelisk-heur-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function touch(rel: string, contents = ''): void {
  const path = join(repo, rel);
  mkdirSync(path.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function mkdir(rel: string): void {
  mkdirSync(join(repo, rel), { recursive: true });
}

describe('heuristic plan walker', () => {
  it('discovers Electron-style features from src/renderer/screens and src/main/agents', () => {
    touch('src/renderer/screens/Home.tsx');
    touch('src/renderer/screens/MissionControl.tsx');
    touch('src/renderer/screens/TestPlans.tsx');
    mkdir('src/main/agents/qa-hunter');
    mkdir('src/main/agents/manual-qa');

    const blocks = buildSkeleton({
      repoPath: repo,
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });

    const sections = blocks
      .filter((b) => b.kind === 'section')
      .map((b) => (b as { title: string }).title);
    const cases = blocks.filter((b) => b.kind === 'case').length;

    // Smoke + at least 4 feature sections
    expect(sections.length).toBeGreaterThanOrEqual(4);
    expect(sections[0]).toBe('Smoke');
    // Names humans understand (capitalized, spaced)
    expect(sections.join(' ')).toMatch(/Home/);
    expect(sections.join(' ')).toMatch(/Mission Control/);
    // Cases are non-trivial
    expect(cases).toBeGreaterThan(8);
  });

  it('discovers web-app features under app/ and src/pages/', () => {
    mkdir('app/checkout');
    mkdir('app/profile');
    mkdir('src/pages/dashboard');

    const blocks = buildSkeleton({
      repoPath: repo,
      agentName: 'manual-qa',
      scope: 'whole-app',
    });

    const sections = blocks
      .filter((b) => b.kind === 'section')
      .map((b) => (b as { title: string }).title);
    expect(sections).toContain('Checkout');
    expect(sections).toContain('Profile');
    expect(sections).toContain('Dashboard');
  });

  it('reads README headings as feature names when other sources are sparse', () => {
    touch(
      'README.md',
      [
        '# My App',
        '',
        '## Installation', // filtered (boilerplate)
        '## Authentication', // kept
        '## Billing flow', // kept
        '',
      ].join('\n'),
    );

    const blocks = buildSkeleton({
      repoPath: repo,
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    const sections = blocks
      .filter((b) => b.kind === 'section')
      .map((b) => (b as { title: string }).title);
    expect(sections).toContain('Authentication');
    expect(sections).toContain('Billing flow');
    expect(sections).not.toContain('Installation');
  });

  it('falls back to Core flows only when nothing usable is found', () => {
    // empty repo
    const blocks = buildSkeleton({
      repoPath: repo,
      agentName: 'qa-hunter',
      scope: 'whole-app',
    });
    const sections = blocks
      .filter((b) => b.kind === 'section')
      .map((b) => (b as { title: string }).title);
    expect(sections).toEqual(['Smoke', 'Core flows']);
  });

  it('feature scope produces a focused two-section skeleton', () => {
    const blocks = buildSkeleton({
      repoPath: repo,
      agentName: 'manual-qa',
      scope: 'feature',
      featureName: 'checkout',
    });
    const sections = blocks
      .filter((b) => b.kind === 'section')
      .map((b) => (b as { title: string }).title);
    expect(sections.length).toBe(2);
    expect(sections[0]).toMatch(/Checkout/);
    expect(sections[1]).toMatch(/edge cases/i);
  });
});
