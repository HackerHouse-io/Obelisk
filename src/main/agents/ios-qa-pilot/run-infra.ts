import { spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const execFile = promisify(execFileCb);

/**
 * Boot a simulator UDID. Idempotent — `xcrun simctl boot` returns
 * `Booted ... is already booted` without erroring on the second call,
 * but we still mask the exit code so callers don't have to special-case it.
 *
 * Then `open -a Simulator` brings the Simulator.app window forward so
 * the user can SEE the run, which is what they expect when they click
 * Run now.
 */
export async function bootSim(udid: string): Promise<void> {
  try {
    await execFile('xcrun', ['simctl', 'boot', udid]);
  } catch {
    // Already-booted is expected when the slot was warmed earlier.
  }
  // Wait until the device finishes booting (services up).
  try {
    await execFile('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  } catch {
    // bootstatus throws on certain transient states; the agent's session
    // creation will time out cleanly if this is a real failure.
  }
  // Show the Simulator window — without this xcrun simctl boot only spins
  // the headless service and the user sees "nothing happens".
  try {
    await execFile('open', ['-a', 'Simulator']);
  } catch {
    // Best-effort. CI / SSH sessions can't open Simulator; that's fine.
  }
}

/**
 * Spawn an Appium server on the given port. Returns the ChildProcess so
 * the orchestrator can SIGTERM it when the run terminates.
 *
 * `--relaxed-security` is required by the xcuitest driver's
 * `mobile: ...` extensions. `--allow-insecure chromedriver_autodownload`
 * lets WDA fetch chromedriver if needed.
 */
export function spawnAppium(port: number, basePath = '/wd/hub'): ChildProcess {
  const child = spawn(
    'appium',
    [
      'server',
      '--address',
      '127.0.0.1',
      '--port',
      String(port),
      '--base-path',
      basePath,
      '--relaxed-security',
    ],
    {
      stdio: 'ignore',
      detached: false,
    },
  );
  // Don't keep the parent alive on the child — the orchestrator handles
  // teardown explicitly via `kill()`.
  child.unref();
  return child;
}

/**
 * Poll http://127.0.0.1:<port>/status until it returns 200 OK or the
 * timeout elapses. Resolves on success, throws on timeout. The Appium
 * server takes 5–15s to be ready on a fresh boot.
 */
export async function waitForAppium(
  port: number,
  basePath = '/wd/hub',
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await probe(port, basePath);
      return;
    } catch (e) {
      lastError = e;
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `Appium did not become ready on port ${port} within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

function probe(port: number, basePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `${basePath}/status`,
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        // Drain so the socket can be reused.
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`status ${res.statusCode}`));
      },
    );
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('probe timeout')));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Quick `appium --version` probe so callers can decide whether to spawn
 * an Appium server or skip preRun entirely (test environments, broken
 * installs). Resolves true on a clean exit, false on any error.
 */
export async function appiumOnPath(): Promise<boolean> {
  try {
    await execFile('appium', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort kill: SIGTERM, then SIGKILL if it doesn't exit. Resolves
 * once the child reports `exit`, or after the timeout — whichever comes
 * first. Safe to call multiple times.
 */
export async function killAppium(child: ChildProcess, gracePeriodMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        done();
      }
    }, gracePeriodMs);
  });
}
