import { listRepos } from '../db/repos';
import { listAgentsForRepo, updateAgent } from '../db/agents';
import {
  listLiveRuns,
  getLastRunStartedAtForAgent,
  getRecentScheduledRunsForAgent,
} from '../db/runs';
import { getSetting } from '../db/settings';
import { runAgent } from '../orchestrator/run';
import { reapStaleRuns } from './heartbeat-reaper';
import { autoMergeSweep } from './auto-merge';
import { backlogSyncSweep } from './backlog-sync';
import { worktreeReaperSweep } from './worktree-reaper';
import { claimSignalReaperSweep } from './claim-signal-reaper';
import { defaultCronFor, isDue } from './cron';
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

/**
 * Default per-repo cap on concurrent runs of code-writing multi-instance
 * agents (bug-fixer, feature-builder). Overridable per repo via the
 * `repo:<id>:bug_fixer_cap` setting. Picked at 3 because it's enough to
 * overlap I/O + LLM latency while staying under typical CI parallelism +
 * GitHub create-PR secondary-rate-limit thresholds.
 */
const PATCH_AGENT_DEFAULT_CAP = 3;

/** Names of multi-instance agents subject to the per-repo cap. */
const PATCH_AGENT_NAMES = new Set<AgentName>(['bug-fixer', 'feature-builder']);

let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
const inFlightDispatch = new Set<string>();

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
      const cap = patchAgentCap(repo);
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
    void runAgent({
      repoId: repo.id,
      agentName: a.name,
      agentId: a.id,
      trigger: 'schedule',
    })
      .catch((e: unknown) => {
        appendAudit({
          runId: 'system',
          kind: 'scheduler_error',
          payload: { repo: repo.githubFullName, agent: a.name, error: String(e) },
        });
      })
      .finally(() => {
        inFlightDispatch.delete(dispatchKey);
      });
  }
}

function countLiveByName(liveRuns: Run[], name: AgentName): number {
  let n = 0;
  for (const r of liveRuns) if (r.agentName === name) n += 1;
  return n;
}

function patchAgentCap(repo: Repo): number {
  const override = getSetting<number>(`repo:${repo.id}`, 'bug_fixer_cap');
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return PATCH_AGENT_DEFAULT_CAP;
}

export function shouldOpenCircuitBreaker(agent: Agent, now: Date): boolean {
  const recent = getRecentScheduledRunsForAgent(agent.id, CIRCUIT_BREAKER_FAILURES);
  if (recent.length < CIRCUIT_BREAKER_FAILURES) return false;
  if (!recent.every((r) => r.state === 'failed')) return false;
  const oldest = recent[recent.length - 1]?.finishedAt;
  if (!oldest) return false;
  const oldestTime = new Date(oldest).getTime();
  if (Number.isNaN(oldestTime)) return false;
  return now.getTime() - oldestTime <= CIRCUIT_BREAKER_WINDOW_MS;
}

function autoPauseAgent(agent: Agent, repo: Repo): void {
  const recent = getRecentScheduledRunsForAgent(agent.id, CIRCUIT_BREAKER_FAILURES);
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
      consecutiveFailures: CIRCUIT_BREAKER_FAILURES,
      windowMs: CIRCUIT_BREAKER_WINDOW_MS,
      recentErrorCodes: recent.map((r) => r.errorCode),
    },
  });
  broadcast({
    type: 'agent.autoPaused',
    repoId: repo.id,
    agentId: agent.id,
    agentName: agent.name,
    displayName: agent.displayName,
    reason: 'consecutive_failures',
    consecutiveFailures: CIRCUIT_BREAKER_FAILURES,
    lastErrorCode: last?.errorCode ?? null,
    lastErrorSummary: last?.outputSummary ?? null,
  });
}
