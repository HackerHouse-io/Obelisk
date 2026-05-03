import { ulid } from 'ulid';
import { getDb } from './index';
import type { Agent, AgentName, RunnerKind } from '../../shared/types';

interface AgentRow {
  id: string;
  repo_id: string;
  name: AgentName;
  enabled: number;
  runner_override: RunnerKind | null;
  schedule_cron: string | null;
  timeout_ms: number;
}

function mapRow(r: AgentRow): Agent {
  return {
    id: r.id,
    repoId: r.repo_id,
    name: r.name,
    enabled: r.enabled === 1,
    runnerOverride: r.runner_override,
    scheduleCron: r.schedule_cron,
    timeoutMs: r.timeout_ms,
  };
}

export function listAgentsForRepo(repoId: string): Agent[] {
  return getDb()
    .prepare<[string], AgentRow>('SELECT * FROM agents WHERE repo_id = ? ORDER BY name')
    .all(repoId)
    .map(mapRow);
}

export interface CreateAgentInput {
  repoId: string;
  name: AgentName;
  enabled?: boolean;
  runnerOverride?: RunnerKind | null;
  scheduleCron?: string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT: Record<AgentName, number> = {
  'qa-hunter': 30 * 60 * 1000,
  'manual-qa': 45 * 60 * 1000,
  'bug-fixer': 30 * 60 * 1000,
  'feature-builder': 60 * 60 * 1000,
  'pr-reviewer': 10 * 60 * 1000,
  'ios-qa-pilot': 45 * 60 * 1000,
};

export function createAgent(input: CreateAgentInput): Agent {
  const id = ulid();
  getDb()
    .prepare(
      `INSERT INTO agents (id, repo_id, name, enabled, runner_override, schedule_cron, timeout_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.name,
      input.enabled === false ? 0 : 1,
      input.runnerOverride ?? null,
      input.scheduleCron ?? null,
      input.timeoutMs ?? DEFAULT_TIMEOUT[input.name],
    );
  const row = getDb().prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) throw new Error('createAgent: row vanished after insert');
  return mapRow(row);
}

export function updateAgent(id: string, patch: Partial<Agent>): Agent {
  const row = getDb().prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) throw new Error(`updateAgent: agent ${id} not found`);
  const next = {
    enabled: patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    runnerOverride: patch.runnerOverride === undefined ? row.runner_override : patch.runnerOverride,
    scheduleCron: patch.scheduleCron === undefined ? row.schedule_cron : patch.scheduleCron,
    timeoutMs: patch.timeoutMs ?? row.timeout_ms,
  };
  getDb()
    .prepare(
      `UPDATE agents SET enabled = ?, runner_override = ?, schedule_cron = ?, timeout_ms = ?
       WHERE id = ?`,
    )
    .run(next.enabled, next.runnerOverride, next.scheduleCron, next.timeoutMs, id);
  const updated = getDb().prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
  if (!updated) throw new Error('updateAgent: row vanished after update');
  return mapRow(updated);
}
