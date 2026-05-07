import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbPathForTesting, closeDb } from '../../src/main/db';
import { runMigrations } from '../../src/main/db/migrations';
import { setSetting } from '../../src/main/db/settings';
import {
  effectiveDefaultModel,
  effectiveDefaultRunner,
} from '../../src/main/runners/effective-default';
import { buildCodexExecArgs } from '../../src/main/prompt-compiler/codex-layout';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'obelisk-model-override-'));
  setDbPathForTesting(join(tmpRoot, 'obelisk.sqlite'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('effectiveDefaultModel', () => {
  it('returns null when Settings has no model configured (CLI default wins)', () => {
    expect(effectiveDefaultModel('claude')).toBeNull();
    expect(effectiveDefaultModel('codex')).toBeNull();
  });

  it('returns the configured model verbatim', () => {
    setSetting('app', 'claudeModel', 'sonnet-4.6');
    setSetting('app', 'codexModel', 'gpt-5-codex');
    expect(effectiveDefaultModel('claude')).toBe('sonnet-4.6');
    expect(effectiveDefaultModel('codex')).toBe('gpt-5-codex');
  });

  it('returns null for blank/whitespace-only configured models', () => {
    setSetting('app', 'claudeModel', '   ');
    expect(effectiveDefaultModel('claude')).toBeNull();
  });

  it('falls back gracefully when DB throws (no settings table)', () => {
    closeDb();
    setDbPathForTesting(join(tmpRoot, 'no-migrations.sqlite'));
    // Intentionally skip runMigrations(); the settings table doesn't exist.
    expect(effectiveDefaultModel('claude')).toBeNull();
  });
});

describe('effectiveDefaultRunner', () => {
  it('honors Settings runner over the per-repo column', () => {
    setSetting('app', 'defaultRunner', 'codex');
    const repo = {
      id: 'r',
      githubFullName: 't/x',
      localPath: '/tmp',
      defaultBranch: 'main',
      mode: 'observe' as const,
      defaultRunner: 'claude' as const,
      connectedAt: new Date().toISOString(),
    };
    expect(effectiveDefaultRunner(repo)).toBe('codex');
  });
});

describe('buildCodexExecArgs', () => {
  it('omits --model entirely when Settings is unset and no override is given', () => {
    const args = buildCodexExecArgs({ sandbox: 'read-only', reasoning: 'high' });
    expect(args).not.toContain('--model');
    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
  });

  it('includes Settings model when present', () => {
    setSetting('app', 'codexModel', 'gpt-5-codex');
    const args = buildCodexExecArgs({ sandbox: 'workspace-write', reasoning: 'medium' });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5-codex');
  });

  it('per-call modelOverride wins over Settings', () => {
    setSetting('app', 'codexModel', 'gpt-5-codex');
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      reasoning: 'high',
      modelOverride: 'gpt-4.5-mini',
    });
    expect(args).toContain('gpt-4.5-mini');
    expect(args).not.toContain('gpt-5-codex');
  });

  it('explicit null override forces CLI default even when Settings has a model', () => {
    setSetting('app', 'codexModel', 'gpt-5-codex');
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      reasoning: 'high',
      modelOverride: null,
    });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('gpt-5-codex');
  });

  it('blank string override is treated the same as null (CLI default)', () => {
    setSetting('app', 'codexModel', 'gpt-5-codex');
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      reasoning: 'high',
      modelOverride: '   ',
    });
    expect(args).not.toContain('--model');
  });
});

describe('regression guards: source files do not pin model names', () => {
  it('generate.ts does not contain a hardcoded `--model` paired with a literal model id', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/main/test-plans/generate.ts', 'utf8');
    expect(/'--model'\s*,\s*'[a-z0-9.-]+'/.test(src)).toBe(false);
  });

  it('codex-layout.ts does not contain a hardcoded `--model` paired with a literal model id', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/main/prompt-compiler/codex-layout.ts', 'utf8');
    expect(/'--model'\s*,\s*'[a-z0-9.-]+'/.test(src)).toBe(false);
  });

  it('claude-layout.ts does not contain a hardcoded model identifier', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/main/prompt-compiler/claude-layout.ts', 'utf8');
    // Match common Claude model patterns we used to hardcode (sonnet-X-Y, opus-X-Y, etc.).
    // The literal `'claude-sonnet-4-6'` was the regression that prompted this guard.
    expect(/['"]claude-(sonnet|opus|haiku)-[\d.-]+['"]/.test(src)).toBe(false);
  });
});
