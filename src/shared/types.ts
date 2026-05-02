/**
 * Phase 0 placeholder. Phase 1 fills this with IPC channel types,
 * BusEvent, SafetyMode, RunState, etc., per docs/TECH_DESIGN.md §3.
 */
export type SafetyMode = 'observe' | 'issues' | 'prs' | 'automerge';
export type RunnerKind = 'claude' | 'codex';
export type RunState = 'queued' | 'running' | 'publishing' | 'done' | 'failed' | 'paused';
