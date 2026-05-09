import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killAppium, waitForAppium } from '../../../../src/main/agents/ios-qa-pilot/run-infra';

describe('waitForAppium', () => {
  it('resolves when /status returns 200', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/wd/hub/status') {
        res.writeHead(200);
        res.end('{"value":{"ready":true}}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await waitForAppium(port, '/wd/hub', { timeoutMs: 3000, intervalMs: 50 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throws when /status never responds', async () => {
    // Pick an obviously-unbound port. Localhost connections will be
    // refused immediately, so the polling loop times out cleanly.
    await expect(
      waitForAppium(59123, '/wd/hub', { timeoutMs: 200, intervalMs: 50 }),
    ).rejects.toThrow(/did not become ready/i);
  });

  it('treats non-200 responses as not-ready and keeps polling until timeout', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        waitForAppium(port, '/wd/hub', { timeoutMs: 200, intervalMs: 50 }),
      ).rejects.toThrow(/did not become ready/i);
      // Verifies we kept polling rather than giving up on the first 503.
      expect(hits).toBeGreaterThan(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('killAppium', () => {
  function fakeChild(): ChildProcess {
    const ee = new EventEmitter() as unknown as ChildProcess;
    let exitCode: number | null = null;
    Object.defineProperty(ee, 'exitCode', { get: () => exitCode });
    Object.defineProperty(ee, 'killed', { get: () => exitCode !== null });
    (ee as unknown as { kill: (signal?: string) => boolean }).kill = (signal) => {
      // Simulate prompt response to SIGTERM.
      setTimeout(() => {
        exitCode = signal === 'SIGKILL' ? 137 : 143;
        ee.emit('exit', exitCode);
      }, 5);
      return true;
    };
    return ee;
  }

  it('resolves once the child exits', async () => {
    const child = fakeChild();
    await killAppium(child, 1000);
    expect(child.exitCode).toBe(143);
  });

  it('is a no-op when the child has already exited', async () => {
    const child = fakeChild();
    await killAppium(child); // first kill
    await killAppium(child); // second is a no-op (no double-kill)
    expect(child.exitCode).toBe(143);
  });
});
