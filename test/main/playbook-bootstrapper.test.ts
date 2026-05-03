import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPlaybook } from '../../src/main/agents/playbook-bootstrapper';
import type { Repo } from '../../src/shared/types';

let tmp: string;

function makeRepo(): Repo {
  return {
    id: 'r1',
    githubFullName: 'fixture/sample',
    localPath: tmp,
    defaultBranch: 'main',
    mode: 'observe',
    defaultRunner: 'claude',
    connectedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obelisk-pb-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('bootstrapPlaybook', () => {
  it('detects an Express repo + generates the 6 qa/*.md + flow stubs', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.18.0', vitest: '^2' } }),
    );
    writeFileSync(join(tmp, 'README.md'), '# sample\n\nA tiny Express service.');
    const out = bootstrapPlaybook({ repo: makeRepo() });
    expect(out.framework).toBe('express');
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toContain('qa/product-map.md');
    expect(paths).toContain('qa/critical-flows.md');
    expect(paths).toContain('qa/expected-behavior.md');
    expect(paths).toContain('qa/bug-rules.md');
    expect(paths).toContain('qa/non-bugs.md');
    expect(paths).toContain('qa/test-users.md');
    // Flow stubs land under qa/playwright/flows/
    const flowFiles = paths.filter((p) => p.startsWith('qa/playwright/flows/'));
    expect(flowFiles.length).toBeGreaterThanOrEqual(3);
    expect(flowFiles.length).toBe(out.criticalFlows.length);
  });

  it('detects a Next.js repo + proposes UI-flavored critical flows', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { next: '14.0.0', react: '18' } }),
    );
    const out = bootstrapPlaybook({ repo: makeRepo() });
    expect(out.framework).toBe('next');
    expect(out.criticalFlows).toContain('Login');
    expect(out.criticalFlows).toContain('Refresh keeps state');
  });

  it('detects a Rails repo via Gemfile + config/routes.rb', () => {
    writeFileSync(join(tmp, 'Gemfile'), 'source "https://rubygems.org"\ngem "rails"');
    mkdirSync(join(tmp, 'config'), { recursive: true });
    writeFileSync(join(tmp, 'config/routes.rb'), 'Rails.application.routes.draw do\nend');
    const out = bootstrapPlaybook({ repo: makeRepo() });
    expect(out.framework).toBe('rails');
  });

  it('flags seeded user credentials as proposed when no seed file exists', () => {
    const out = bootstrapPlaybook({ repo: makeRepo() });
    expect(out.seedUsers.every((u) => u.proposed)).toBe(true);
    expect(out.seedUsers.map((u) => u.role)).toContain('normal_user');
  });

  it('points users at the seed file when one is detected', () => {
    writeFileSync(join(tmp, 'seed.sql'), 'INSERT INTO users …');
    const out = bootstrapPlaybook({ repo: makeRepo() });
    const normal = out.seedUsers.find((u) => u.role === 'normal_user');
    expect(normal?.password).toContain('seed.sql');
  });

  it('falls back to unknown framework when nothing recognized', () => {
    const out = bootstrapPlaybook({ repo: makeRepo() });
    expect(out.framework).toBe('unknown');
    expect(out.criticalFlows).toEqual(['Login', 'Sign up', 'Logout']);
  });
});
