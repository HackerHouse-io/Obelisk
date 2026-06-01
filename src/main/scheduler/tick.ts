import { listRepos } from '../db/repos';
import { listAgentsForRepo, updateAgent } from '../db/agents';
import {
  listLiveRuns,
  getLastRunStartedAtForAgent,
  getRecentScheduledRunsForAgent,
} from '../db/runs';
import { getPatchAgentCap, PATCH_AGENT_NAMES } from './patch-agent-cap';
import { runAgent } from '../orchestrator/run';
import { reapStaleRuns } from './heartbeat-reaper';
import { autoMergeSweep } from './auto-merge';
import { backlogSyncSweep } from './backlog-sync';
import { worktreeReaperSweep } from './worktree-reaper';
import { claimSignalReaperSweep } from './claim-signal-reaper';
import { defaultCronFor, isDue } from './cron';
import { getCoverageSchedule } from './coverage-schedule';
import { startCoverageRun } from '../coverage/agent-loop';
import { pickWorstCoveragePlanId } from '../coverage/pick-plan';
import { getActiveCoverageRun, getLatestCoverageRun } from '../db/coverage-runs';
import { broadcast } from '../ipc/bus';
import { appendAudit } from '../logger/audit';
import type { Agent, AgentName, Repo, Run } from '../../shared/types';
import { getAgentHandler, listImplementedAgents } from '../agents/registry';

/** Auto-pause threshold: N consecutive scheduled failures within the window. */
const CIRCUIT_BREAKER_FAILURES = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const TICK_MS = 30_000;
const AUTO_MERGE_EVERY_N_TICKS = 10; // = 5 min
// 5-minute auto-sync. The cost is small (Octokit's ETag cache turns most
// calls into 304s with zero quota cost) but a 5-min cadence means a
// merged PR's issue lingers in "Next up" for at most ~5 min — and the
// Backlog screen has a manual Refresh button for users who want it
// instantly. Earlier 2-min cadence felt chatty without much benefit.
const BACKLOG_SYNC_EVERY_N_TICKS = 10; // = 5 min
const WORKTREE_REAPER_EVERY_N_TICKS = 20; // = 10 min
// The Coverage Agent is heavy (it spawns generation + hunt runs) and converges
// over many passes, so a slow cadence is plenty — we only check whether a
// repo's cron is due every 10 min.
const COVERAGE_SWEEP_EVERY_N_TICKS = 20; // = 10 min

let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
const inFlightDispatch = new Set<string>();
const inFlightCoverageLoop = new Set<string>();

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(): SchedulerHandle {
  stopScheduler();
  // Fire one tick immediately so the renderer sees activity without waiting.
  void tick();
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  return { stop: stopScheduler };
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  tickCount = 0;
  inFlightDispatch.clear();
  inFlightCoverageLoop.clear();
}

async function tick(): Promise<void> {
  tickCount += 1;
  broadcast({ type: 'system.heartbeat', at: new Date().toISOString() });

  reapStaleRuns();

  for (const repo of listRepos()) {
    dispatchDueAgents(repo);
  }

  if (tickCount % BACKLOG_SYNC_EVERY_N_TICKS === 0) {
    void backlogSyncSweep();
  }
  if (tickCount % AUTO_MERGE_EVERY_N_TICKS === 0) {
    void autoMergeSweep();
  }
  if (tickCount % WORKTREE_REAPER_EVERY_N_TICKS === 0) {
    void worktreeReaperSweep();
    // Same cadence as the worktree reaper: same 24h staleness window
    // governs both, and rolling them onto adjacent ticks keeps the audit
    // log easier to read.
    void claimSignalReaperSweep();
  }
  if (tickCount % COVERAGE_SWEEP_EVERY_N_TICKS === 0) {
    for (const repo of listRepos()) {
      coverageLoopSweep(repo);
    }
  }
}

/**
 * Dispatch the autonomous Coverage Agent when a repo's cron is due. Opt-in
 * per repo via `coverage.enabled`. Single-flight: never overlap with an
 * in-flight pass (DB-level) or another sweep tick (in-memory set). The pass
 * itself is budget-bounded, so a scheduled run can't run away.
 */
function coverageLoopSweep(repo: Repo): void {
  const schedule = getCoverageSchedule(repo.id);
  if (!schedule.enabled) return;
  if (inFlightCoverageLoop.has(repo.id)) return;
  if (getActiveCoverageRun(repo.id)) return;

  const latest = getLatestCoverageRun(repo.id);
  const basis = latest ? new Date(latest.startedAt) : new Date(repo.connectedAt);
  if (!isDue(schedule.cron, basis)) return;

  inFlightCoverageLoop.add(repo.id);
  try {
    startCoverageRun(repo.id, { trigger: 'schedule' });
  } catch (e) {
    appendAudit({
      runId: 'system',
      kind: 'scheduler_error',
      payload: { repo: repo.githubFullName, agent: 'coverage-agent', error: String(e) },
    });
  } finally {
    // startCoverageRun returns synchronously (the pass runs in the
    // background and is guarded by getActiveCoverageRun on the next tick),
    // so we only need this set to dedup within a single sweep pass.
    inFlightCoverageLoop.delete(repo.id);
  }
}

function dispatchDueAgents(repo: Repo): void {
  const agents = listAgentsForRepo(repo.id);
  const implemented = new Set(listImplementedAgents());
  const liveRuns = listLiveRuns(repo.id);
  const liveAgentIds = new Set(liveRuns.map((r) => r.agentId).filter((id): id is string => !!id));
  const liveAgentNames = new Set(liveRuns.map((r) => r.agentName));
  const now = new Date();

  for (const a of agents) {
    if (!a.enabled) continue;
    if (!implemented.has(a.name)) continue;

    // Per-instance single-flight: this exact instance is already running.
    if (liveAgentIds.has(a.id)) continue;

    // Per-type singleton fallback: handlers that declare multiInstance:false
    // (qa-hunter, manual-qa today) must not run two of their type at once,
    // even if they're separate instance rows.
    const handler = getAgentHandler(a.name);
    if (!handler.multiInstance && liveAgentNames.has(a.name)) continue;

    // Per-repo cap on patch-producing multi-instance agents. Adding more
    // bug-fixer instances is the user's primary scaling lever, but unbounded
    // parallelism risks GitHub secondary rate-limits and CI thrash.
    if (PATCH_AGENT_NAMES.has(a.name) && handler.multiInstance) {
      const cap = getPatchAgentCap(repo.id);
      if (countLiveByName(liveRuns, a.name) >= cap) continue;
    }

    // Defense-in-depth: tick-local dispatch dedup. For multi-instance handlers
    // we key by id; for singletons we key by name so two rows of the same
    // singleton type can't both be dispatched within the same tick cycle
    // (the liveAgentNames check above only catches AlreadyRunning, not
    // AlreadyDispatching-in-this-tick).
    const dispatchKey = handler.multiInstance ? `${repo.id}:${a.id}` : `${repo.id}:name:${a.name}`;
    if (inFlightDispatch.has(dispatchKey)) continue;

    const cron = a.scheduleCron ?? defaultCronFor(a.name);
    const basis = getLastRunStartedAtForAgent(a.id) ?? new Date(repo.connectedAt);
    if (!isDue(cron, basis, now)) continue;

    // Circuit breaker: if the last few scheduled runs all failed inside the
    // window, the agent's setup is almost certainly broken (auth expired,
    // rate-limited, missing CLI, malformed plan). Auto-pause so we don't
    // burn credits on every cron tick. The user gets a toast explaining why
    // and re-enables once they've fixed the underlying issue.
    if (shouldOpenCircuitBreaker(a, now)) {
      autoPauseAgent(a, repo);
      continue;
    }

    inFlightDispatch.add(dispatchKey);
    void (async () => {
      try {
        // QA agents must run against a concrete plan. The manual "Run now"
        // path resolves the agent's defaultPlanId; the scheduler did not,
        // so a scheduled run with multiple plans threw TEST_PLAN_REQUIRED
        // before a run row existed — leaving the schedule stuck at "Next
        // now" forever. Resolve the plan here: the bound default if set,
        // else the plan whose feature has the lowest coverage (worst-first).
        let taskId: string | undefined;
        if (handler.requiresTestPlan) {
          const planId = a.defaultPlanId ?? (await pickWorstCoveragePlanId(repo, a.name));
          if (!planId) {
            // No plan to run and none can be auto-picked. Auto-pause so the
            // schedule stops claiming "Next now" and the user is told why,
            // instead of silently retrying every tick (no run row is created,
            // so the circuit breaker can't catch this case).
            autoPauseAgent(a, repo, { reason: 'needs_test_plan' });
            return;
          }
          taskId = `plan:${planId}`;
        }
        await runAgent({
          repoId: repo.id,
          agentName: a.name,
          agentId: a.id,
          trigger: 'schedule',
          ...(taskId !== undefined ? { taskId } : {}),
        });
      } catch (e: unknown) {
        appendAudit({
          runId: 'system',
          kind: 'scheduler_error',
          payload: { repo: repo.githubFullName, agent: a.name, error: String(e) },
        });
      } finally {
        inFlightDispatch.delete(dispatchKey);
      }
    })();
  }
}

function countLiveByName(liveRuns: Run[], name: AgentName): number {
  let n = 0;
  for (const r of liveRuns) if (r.agentName === name) n += 1;
  return n;
}

/**
 * Failures the auto-retry layer can't fix — a retry just repeats the same
 * verdict. ONLY these stop the agent via the breaker. Transient failures
 * (INTERNAL/TIMEOUT/RUNNER_NO_OUTPUT/…) are handled by bounded retries and must
 * never disable a scheduled agent — otherwise flaky CLIs make it unreliable.
 */
const PERMANENT_FAILURE_CODES = new Set<string>([
  'RUNNER_LOGIN_REQUIRED',
  'RUNNER_NOT_INSTALLED',
  'MODE_TOO_LOW',
  'TEST_PLAN_REQUIRED',
  'ACTOR_NOT_ALLOWLISTED',
]);

export function shouldOpenCircuitBreaker(agent: Agent, now: Date): boolean {
  const recent = getRecentScheduledRunsForAgent(agent.id, CIRCUIT_BREAKER_FAILURES);
  if (recent.length < CIRCUIT_BREAKER_FAILURES) return false;
  // Every recent scheduled run must be a failure carrying a PERMANENT code.
  // A transient-coded failure (or a success) breaks the streak — those don't
  // stop the agent; the retry layer owns them.
  if (!recent.every((r) => r.state === 'failed' && PERMANENT_FAILURE_CODES.has(r.errorCode ?? '')))
    return false;
  const oldest = recent[recent.length - 1]?.finishedAt;
  if (!oldest) return false;
  const oldestTime = new Date(oldest).getTime();
  if (Number.isNaN(oldestTime)) return false;
  return now.getTime() - oldestTime <= CIRCUIT_BREAKER_WINDOW_MS;
}

function autoPauseAgent(
  agent: Agent,
  repo: Repo,
  opts: { reason?: 'consecutive_failures' | 'needs_test_plan' } = {},
): void {
  const reason = opts.reason ?? 'consecutive_failures';
  const needsPlan = reason === 'needs_test_plan';
  const recent = needsPlan
    ? []
    : getRecentScheduledRunsForAgent(agent.id, CIRCUIT_BREAKER_FAILURES);
  const last = recent[0];
  try {
    updateAgent(agent.id, { enabled: false });
  } catch (e) {
    appendAudit({
      runId: 'system',
      kind: 'scheduler_error',
      payload: {
        repo: repo.githubFullName,
        agent: agent.name,
        error: `auto-pause failed: ${String(e)}`,
      },
    });
    return;
  }
  appendAudit({
    runId: 'system',
    kind: 'scheduler_circuit_breaker',
    payload: {
      agentId: agent.id,
      agentName: agent.name,
      repo: repo.githubFullName,
      reason,
      ...(needsPlan
        ? {}
        : {
            consecutiveFailures: CIRCUIT_BREAKER_FAILURES,
            windowMs: CIRCUIT_BREAKER_WINDOW_MS,
            recentErrorCodes: recent.map((r) => r.errorCode),
          }),
    },
  });
  broadcast({
    type: 'agent.autoPaused',
    repoId: repo.id,
    agentId: agent.id,
    agentName: agent.name,
    displayName: agent.displayName,
    reason,
    consecutiveFailures: needsPlan ? 0 : CIRCUIT_BREAKER_FAILURES,
    lastErrorCode: needsPlan ? 'TEST_PLAN_REQUIRED' : (last?.errorCode ?? null),
    lastErrorSummary: needsPlan
      ? 'No test plan to run. Create or attach a plan for this agent, then re-enable it.'
      : (last?.outputSummary ?? null),
  });
}
