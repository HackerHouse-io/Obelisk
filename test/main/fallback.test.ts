import { describe, it, expect, beforeEach } from 'vitest';
import { runnerFallback, classifyOutcome } from '../../src/main/runners/fallback';

describe('runnerFallback', () => {
  beforeEach(() => {
    runnerFallback.clear('task-1');
  });

  it('keeps the preferred runner until it fails twice', () => {
    expect(runnerFallback.decide('task-1', 'claude')).toBe('claude');
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    expect(runnerFallback.decide('task-1', 'claude')).toBe('claude');
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    expect(runnerFallback.decide('task-1', 'claude')).toBe('codex');
  });

  it('returns null after 4 total attempts', () => {
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    runnerFallback.record('task-1', 'codex', 'fatal_fail');
    runnerFallback.record('task-1', 'codex', 'fatal_fail');
    expect(runnerFallback.decide('task-1', 'claude')).toBeNull();
  });

  it('a successful run resets the consecutive-fail counter', () => {
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    runnerFallback.record('task-1', 'claude', 'fatal_fail');
    expect(runnerFallback.decide('task-1', 'claude')).toBe('codex');
    runnerFallback.record('task-1', 'claude', 'ok');
    expect(runnerFallback.decide('task-1', 'claude')).toBe('claude');
  });

  it("classifies reasons correctly", () => {
    expect(classifyOutcome(undefined)).toBe('ok');
    expect(classifyOutcome('crash')).toBe('fatal_fail');
    expect(classifyOutcome('non_zero_exit')).toBe('fatal_fail');
    expect(classifyOutcome('timeout')).toBe('soft_fail');
    expect(classifyOutcome('no_changes')).toBe('soft_fail');
  });
});
