import { listRepos } from '../db/repos';
import { listAgentsForRepo } from '../db/agents';
import { listLiveRuns, getLastRunStartedAtForAgent } from '../db/runs';
import { runAgent } from '../orchestrator/run';
import { reapStaleRuns } from './heartbeat-reaper';
import { autoMergeSweep } from './auto-merge';
import { defaultCronFor, isDue } from './cron';
import { broadcast } from '../ipc/bus';
import { appendAudit } from '../logger/audit';
import type { Repo } from '../../shared/types';
import { getAgentHandler, listImplementedAgents } from '../agents/registry';

const TICK_MS = 30_000;
const AUTO_MERGE_EVERY_N_TICKS = 10; // = 5 min

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

  if (tickCount % AUTO_MERGE_EVERY_N_TICKS === 0) {
    void autoMergeSweep();
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

    const dispatchKey = `${repo.id}:${a.id}`;
    if (inFlightDispatch.has(dispatchKey)) continue;

    const cron = a.scheduleCron ?? defaultCronFor(a.name);
    const basis = getLastRunStartedAtForAgent(a.id) ?? new Date(repo.connectedAt);
    if (!isDue(cron, basis, now)) continue;

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
