import { spawn, type ChildProcess } from 'node:child_process';
import type { AuditLine } from './types';

export interface SpawnOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  onAudit: (line: AuditLine) => void;
  abort: AbortSignal;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: 'SIGTERM' | 'SIGKILL' | string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a subprocess with an allow-listed env (no inheritance from
 * `process.env`) and stream stdout/stderr line-by-line into the audit
 * log. Resolves only when the process exits.
 */
export function spawnAgentCli(opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(e);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Hard-kill 5s after SIGTERM if the child ignored it.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000).unref();
    }, opts.timeoutMs);

    const abortHandler = (): void => {
      child.kill('SIGTERM');
    };
    if (opts.abort.aborted) {
      abortHandler();
    } else {
      opts.abort.addEventListener('abort', abortHandler, { once: true });
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length === 0) continue;
          opts.onAudit({ at: new Date().toISOString(), kind: 'stdout', payload: line });
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length === 0) continue;
          opts.onAudit({ at: new Date().toISOString(), kind: 'stderr', payload: line });
        }
      });
    }

    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    child.on('error', (e) => {
      clearTimeout(timer);
      opts.abort.removeEventListener('abort', abortHandler);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.abort.removeEventListener('abort', abortHandler);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Quick existence check: run `<command> --version` with a short timeout.
 */
export async function checkInstalled(
  command: string,
): Promise<{ ok: boolean; version?: string; hint?: string }> {
  try {
    const result = await spawnAgentCli({
      command,
      args: ['--version'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 5000,
      onAudit: () => undefined,
      abort: new AbortController().signal,
    });
    if (result.exitCode === 0) {
      const version = result.stdout.trim().split(/\s+/).pop() ?? '';
      return { ok: true, version };
    }
    return { ok: false, hint: `${command} --version exited with ${result.exitCode ?? '?'}` };
  } catch (e) {
    return {
      ok: false,
      hint: `${command} not found on PATH (${(e as Error).message})`,
    };
  }
}
