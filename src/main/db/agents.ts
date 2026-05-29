import { ulid } from 'ulid';
import { getDb } from './index';
import type {
  Agent,
  AgentName,
  AgentPermissions,
  RunnerKind,
  ScheduleConfig,
} from '../../shared/types';

interface AgentRow {
  id: string;
  repo_id: string;
  name: AgentName;
  display_name: string;
  enabled: number;
  runner_override: RunnerKind | null;
  model_override: string | null;
  schedule_cron: string | null;
  schedule_json: string | null;
  timeout_ms: number;
  perm_read_code: number;
  perm_run_tests: number;
  perm_create_issues: number;
  perm_draft_prs: number;
  perm_merge: number;
  default_plan_id: string | null;
  created_at: string;
}

function mapRow(r: AgentRow): Agent {
  return {
    id: r.id,
    repoId: r.repo_id,
    name: r.name,
    displayName: r.display_name,
    enabled: r.enabled === 1,
    runnerOverride: r.runner_override,
    modelOverride: r.model_override,
    scheduleCron: r.schedule_cron,
    schedule: parseScheduleJson(r.schedule_json),
    timeoutMs: r.timeout_ms,
    permissions: {
      readCode: r.perm_read_code === 1,
      runTests: r.perm_run_tests === 1,
      createIssues: r.perm_create_issues === 1,
      draftPrs: r.perm_draft_prs === 1,
      merge: r.perm_merge === 1,
    },
    createdAt: r.created_at,
    multiInstance: false, // filled at IPC boundary from the registry
    defaultPlanId: r.default_plan_id,
  };
}

function parseScheduleJson(raw: string | null): ScheduleConfig | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScheduleConfig;
  } catch {
    return null;
  }
}

const DEFAULT_DISPLAY_NAME: Record<AgentName, string> = {
  'qa-hunter': 'QA Hunter',
  'manual-qa': 'Manual QA',
  'bug-fixer': 'Bug Fixer',
  'feature-builder': 'Feature Builder',
  'pr-reviewer': 'PR Reviewer',
  'ios-qa-pilot': 'iOS QA Pilot',
};

const DEFAULT_PERMS: Record<AgentName, AgentPermissions> = {
  'qa-hunter': {
    readCode: true,
    runTests: true,
    createIssues: true,
    draftPrs: false,
    merge: false,
  },
  'manual-qa': {
    readCode: true,
    runTests: true,
    createIssues: true,
    draftPrs: false,
    merge: false,
  },
  'bug-fixer': { readCode: true, runTests: true, createIssues: true, draftPrs: true, merge: false },
  'feature-builder': {
    readCode: true,
    runTests: true,
    createIssues: true,
    draftPrs: true,
    merge: false,
  },
  'pr-reviewer': {
    readCode: true,
    runTests: true,
    createIssues: false,
    draftPrs: false,
    merge: false,
  },
  'ios-qa-pilot': {
    readCode: true,
    runTests: true,
    createIssues: true,
    draftPrs: false,
    merge: false,
  },
};

export function listAgentsForRepo(repoId: string): Agent[] {
  return getDb()
    .prepare<
      [string],
      AgentRow
    >('SELECT * FROM agents WHERE repo_id = ? ORDER BY name, created_at ASC')
    .all(repoId)
    .map(mapRow);
}

export function getAgent(id: string): Agent | null {
  const row = getDb().prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function countAgentsByName(repoId: string, name: AgentName): number {
  const row = getDb()
    .prepare<
      [string, string],
      { c: number }
    >('SELECT COUNT(*) AS c FROM agents WHERE repo_id = ? AND name = ?')
    .get(repoId, name);
  return row?.c ?? 0;
}

export interface CreateAgentInput {
  repoId: string;
  name: AgentName;
  displayName?: string;
  enabled?: boolean;
  runnerOverride?: RunnerKind | null;
  scheduleCron?: string | null;
  timeoutMs?: number;
  permissions?: Partial<AgentPermissions>;
}

const DEFAULT_TIMEOUT: Record<AgentName, number> = {
  'qa-hunter': 30 * 60 * 1000,
  'manual-qa': 45 * 60 * 1000,
  'bug-fixer': 30 * 60 * 1000,
  'feature-builder': 60 * 60 * 1000,
  // PR Reviewer compiles + runs the repo's test suite (and reruns it after
  // each fix in fix mode). 10 min was far too short for repos with real
  // build+test cycles (e.g. Xcode), so reviews were SIGKILL'd mid-test.
  // Match the read/test agents at 30 min. Migration 013 bumps existing rows.
  'pr-reviewer': 30 * 60 * 1000,
  'ios-qa-pilot': 45 * 60 * 1000,
};

/**
 * Pick a display name that doesn't collide with existing instances of the same
 * type in the same repo: "Bug Fixer", "Bug Fixer 2", "Bug Fixer 3", ...
 */
function pickUniqueDisplayName(repoId: string, name: AgentName, requested?: string): string {
  const base = (requested ?? DEFAULT_DISPLAY_NAME[name]).trim() || DEFAULT_DISPLAY_NAME[name];
  const taken = new Set(
    getDb()
      .prepare<[string, string], { display_name: string }>(
        'SELECT display_name FROM agents WHERE repo_id = ? AND name = ?',
      )
      .all(repoId, name)
      .map((r) => r.display_name),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${ulid().slice(-4)}`;
}

export function createAgent(input: CreateAgentInput): Agent {
  const id = ulid();
  const perms = { ...DEFAULT_PERMS[input.name], ...(input.permissions ?? {}) };
  const displayName = pickUniqueDisplayName(input.repoId, input.name, input.displayName);
  getDb()
    .prepare(
      `INSERT INTO agents (
        id, repo_id, name, display_name, enabled, runner_override, model_override,
        schedule_cron, schedule_json, timeout_ms,
        perm_read_code, perm_run_tests, perm_create_issues, perm_draft_prs, perm_merge,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.name,
      displayName,
      input.enabled === true ? 1 : 0,
      input.runnerOverride ?? null,
      input.scheduleCron ?? null,
      input.timeoutMs ?? DEFAULT_TIMEOUT[input.name],
      perms.readCode ? 1 : 0,
      perms.runTests ? 1 : 0,
      perms.createIssues ? 1 : 0,
      perms.draftPrs ? 1 : 0,
      perms.merge ? 1 : 0,
      new Date().toISOString(),
    );
  const row = getAgent(id);
  if (!row) throw new Error('createAgent: row vanished after insert');
  return row;
}

export function cloneAgent(sourceId: string): Agent {
  const src = getAgent(sourceId);
  if (!src) throw new Error(`cloneAgent: source ${sourceId} not found`);
  return createAgent({
    repoId: src.repoId,
    name: src.name,
    displayName: src.displayName, // pickUnique adds a suffix
    enabled: false, // clones land paused — explicit user enable prevents 2× billing
    runnerOverride: src.runnerOverride,
    scheduleCron: src.scheduleCron,
    timeoutMs: src.timeoutMs,
    permissions: src.permissions,
  });
}

export function deleteAgent(id: string): void {
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(id);
}

export function updateAgent(id: string, patch: Partial<Agent>): Agent {
  const existing = getAgent(id);
  if (!existing) throw new Error(`updateAgent: agent ${id} not found`);

  const next = {
    displayName: patch.displayName ?? existing.displayName,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    runnerOverride:
      patch.runnerOverride === undefined ? existing.runnerOverride : patch.runnerOverride,
    modelOverride: patch.modelOverride === undefined ? existing.modelOverride : patch.modelOverride,
    scheduleCron: patch.scheduleCron === undefined ? existing.scheduleCron : patch.scheduleCron,
    schedule: patch.schedule === undefined ? existing.schedule : patch.schedule,
    timeoutMs: patch.timeoutMs ?? existing.timeoutMs,
    permissions: patch.permissions ?? existing.permissions,
    defaultPlanId:
      patch.defaultPlanId === undefined ? (existing.defaultPlanId ?? null) : patch.defaultPlanId,
  };

  // When the user edits via the segmented schedule editor, derive cron so the
  // scheduler stays unchanged. Manual / event modes write null cron so the
  // scheduler treats them as "no recurring trigger".
  const derivedCron =
    next.schedule != null ? scheduleConfigToCron(next.schedule) : next.scheduleCron;

  getDb()
    .prepare(
      `UPDATE agents SET
         display_name = ?,
         enabled = ?,
         runner_override = ?,
         model_override = ?,
         schedule_cron = ?,
         schedule_json = ?,
         timeout_ms = ?,
         perm_read_code = ?,
         perm_run_tests = ?,
         perm_create_issues = ?,
         perm_draft_prs = ?,
         perm_merge = ?,
         default_plan_id = ?
       WHERE id = ?`,
    )
    .run(
      next.displayName,
      next.enabled ? 1 : 0,
      next.runnerOverride,
      next.modelOverride,
      derivedCron,
      next.schedule ? JSON.stringify(next.schedule) : null,
      next.timeoutMs,
      next.permissions.readCode ? 1 : 0,
      next.permissions.runTests ? 1 : 0,
      next.permissions.createIssues ? 1 : 0,
      next.permissions.draftPrs ? 1 : 0,
      next.permissions.merge ? 1 : 0,
      next.defaultPlanId ?? null,
      id,
    );

  const updated = getAgent(id);
  if (!updated) throw new Error('updateAgent: row vanished after update');
  return updated;
}

/**
 * Project a ScheduleConfig down to a 5-field cron expression for the existing
 * scheduler. Returns null for modes the cron scheduler can't represent (event,
 * manual) — the scheduler treats null as "don't dispatch".
 */
export function scheduleConfigToCron(s: ScheduleConfig): string | null {
  if (s.mode === 'manual') return null;
  if (s.mode === 'event') return null;
  if (s.mode === 'cron') return s.cron ?? null;
  if (s.mode === 'recurring') {
    const every = s.every ?? 1;
    const at = s.at ?? '00:00';
    const [hStr, mStr] = at.split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    const days = s.days ?? [1, 1, 1, 1, 1, 1, 1];
    const dows = days.every((d) => d === 1)
      ? '*'
      : days
          .map((d, i) => (d ? (i + 1) % 7 : null))
          .filter((v): v is number => v !== null)
          .join(',');
    if (s.unit === 'minute') return `*/${every} * * * ${dows}`;
    if (s.unit === 'hour') return `0 */${every} * * ${dows}`;
    if (s.unit === 'day') return `${m} ${h} */${every} * *`;
    if (s.unit === 'week') return `${m} ${h} * * ${dows}`;
  }
  return null;
}
