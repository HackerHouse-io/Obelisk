import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { SeedAgent, SeedPreview, SeedRepo } from './seed';
import { seed } from './seed';

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const MAIN_ENTRY = join(PROJECT_ROOT, 'out', 'main', 'index.js');

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  repoDir: string;
  fixtures: { repo: SeedRepo; agents: SeedAgent[]; previews: SeedPreview[] } | null;
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  /** If set, seed the DB at userDataDir before booting Electron. */
  seedFixtures?: Omit<Parameters<typeof seed>[0], 'userDataDir' | 'repoLocalPath'>;
  /**
   * Override PATH for the Electron process. Defaults to a minimal PATH that
   * excludes any developer-installed claude/codex CLIs so tests stay
   * deterministic. Pass an explicit value (with stub binaries) when you need
   * the runner preflight to pass.
   */
  pathOverride?: string;
}

/**
 * Boot the packaged Electron app against an isolated user-data dir + a
 * throwaway git fixture repo. Optionally pre-seeds the SQLite DB so the
 * renderer comes up with a connected repo + agents already in place.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-e2e-'));
  const userDataDir = join(root, 'userdata');
  const repoDir = join(root, 'repo');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.name "E2E"', { cwd: repoDir });
  execSync('git config user.email "e2e@example.com"', { cwd: repoDir });
  execSync('git config commit.gpgsign false', { cwd: repoDir });
  execSync('git add . && git commit -q -m initial', { cwd: repoDir });
  execSync('git branch -M main', { cwd: repoDir });

  let fixtures: LaunchedApp['fixtures'] = null;
  if (opts.seedFixtures) {
    fixtures = seed({ ...opts.seedFixtures, userDataDir, repoLocalPath: repoDir });
  }

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      OBELISK_E2E: '1',
      PATH: opts.pathOverride ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    timeout: 30_000,
  });

  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState('domcontentloaded');

  return {
    app,
    window,
    userDataDir,
    repoDir,
    fixtures,
    cleanup: async () => {
      try {
        await app.close();
      } catch {
        // ignore
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
