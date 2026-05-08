import {
  cloneAgent as cloneAgentRow,
  countAgentsByName,
  createAgent,
  deleteAgent as deleteAgentRow,
  getAgent,
  listAgentsForRepo,
  updateAgent,
} from '../db/agents';
import { getRepo } from '../db/repos';
import { getLastRunStartedAtForAgent, listLiveRuns } from '../db/runs';
import { runAgent } from '../orchestrator/run';
import { defaultCronFor, nextFireAt } from '../scheduler/cron';
import { ObeliskError } from '../../shared/errors';
import { getAgentHandler } from '../agents/registry';
import type { Agent, IpcMap, RunnerKind } from '../../shared/types';
import { readAgentMd } from '../agents/skill-loader';
import { ClaudeCodeRunner } from '../runners/claude-code';
import { CodexRunner } from '../runners/codex';

function decorate(agent: Agent, connectedAt: Date): Agent {
  const handler = (() => {
    try {
      return getAgentHandler(agent.name);
    } catch {
      return null;
    }
  })();
  const cron = agent.scheduleCron ?? defaultCronFor(agent.name);
  const lastRun = getLastRunStartedAtForAgent(agent.id);
  const basis = lastRun ?? connectedAt;
  const next = agent.enabled ? nextFireAt(cron, basis) : null;
  return {
    ...agent,
    multiInstance: handler?.multiInstance ?? true,
    lastRunAt: lastRun ? lastRun.toISOString() : null,
    nextFireAt: next ? next.toISOString() : null,
  };
}

export async function handleAgentsList(
  payload: IpcMap['agents:list']['req'],
): Promise<IpcMap['agents:list']['res']> {
  const agents = listAgentsForRepo(payload.repoId);
  const repo = getRepo(payload.repoId);
  const connectedAt = repo ? new Date(repo.connectedAt) : new Date();
  return agents.map((a) => decorate(a, connectedAt));
}

export async function handleAgentsRun(
  payload: IpcMap['agents:run']['req'],
): Promise<IpcMap['agents:run']['res']> {
  const agent = getAgent(payload.agentId);
  if (!agent) {
    throw new ObeliskError('AGENT_NOT_FOUND', `agent ${payload.agentId} not found`);
  }
  await ensureRunnerAvailable();

  // runAgent drives the entire run synchronously — selectTask, createRun,
  // CLI spawn, publish — and that takes anywhere from seconds to minutes.
  // The IPC must NOT wait for that whole journey, or the renderer's "Run
  // now" / "Run QA Hunter" spinners stay spinning until the run completes.
  // Resolve as soon as the run row exists (orchestrator fires `onStarted`
  // right after createRun) and let the rest happen in the background.
  return new Promise<IpcMap['agents:run']['res']>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    runAgent({
      repoId: agent.repoId,
      agentName: agent.name,
      agentId: agent.id,
      trigger: 'manual',
      taskId: payload.taskId,
      ...(payload.runnerOverride ? { runnerOverride: payload.runnerOverride } : {}),
      ...(payload.modelOverride !== undefined ? { modelOverride: payload.modelOverride } : {}),
      onStarted: (runId) => settle(() => resolve({ runId })),
    }).then(
      (result) => {
        // selectTask returned null (or some other path that completed
        // without ever firing onStarted, e.g. a same-agent-already-running
        // error). Surface as NOT_FOUND so the renderer can show a useful
        // message instead of a stuck spinner.
        settle(() =>
          result.runId
            ? resolve({ runId: result.runId })
            : reject(
                new ObeliskError('NOT_FOUND', result.reason ?? 'No task to work on right now.'),
              ),
        );
      },
      (err) => {
        // Pre-onStarted failure (e.g. createRun threw on a duplicate
        // task_ref). Reject so the renderer surfaces an error banner.
        // Errors after onStarted are logged by the orchestrator's own
        // failure-classification path and do not affect this promise.
        settle(() => reject(err));
      },
    );
  });
}

async function ensureRunnerAvailable(): Promise<RunnerKind> {
  const claude = await new ClaudeCodeRunner().isInstalled();
  if (claude.ok) return 'claude';
  const codex = await new CodexRunner().isInstalled();
  if (codex.ok) return 'codex';
  throw new ObeliskError(
    'RUNNER_NOT_INSTALLED',
    'Neither Claude Code nor Codex CLI is installed.',
    "Install one of them and make sure it's on PATH. Try 'claude --version' or 'codex --version' in a terminal.",
  );
}

export async function handleAgentsCancel(
  payload: IpcMap['agents:cancel']['req'],
): Promise<IpcMap['agents:cancel']['res']> {
  const { cancelRun, isActive } = await import('../orchestrator/active-runs');
  const { getRun, transitionRun } = await import('../db/runs');
  const { appendAudit } = await import('../logger/audit');

  const run = getRun(payload.runId);
  if (!run) throw new ObeliskError('RUN_NOT_FOUND', `run ${payload.runId} not found`);
  if (run.state === 'done' || run.state === 'failed' || run.state === 'cancelled') {
    // Already terminal — silently no-op so double-clicks don't error.
    return { ok: true };
  }

  if (isActive(payload.runId)) {
    // Abort the live spawn. The orchestrator's runIsCancelled() check then
    // transitions the run to 'cancelled' (not 'failed') after the spawn dies.
    cancelRun(payload.runId);
    return { ok: true };
  }

  // Run is queued / publishing but not in our in-memory active map — likely
  // a stale row from a previous process. Mark it cancelled directly so the
  // user can clear it from Mission Control.
  appendAudit({
    runId: payload.runId,
    kind: 'state',
    payload: { from: run.state, to: 'cancelled', reason: 'user_cancelled' },
  });
  transitionRun(payload.runId, 'cancelled', { outputSummary: 'Stopped by the user.' });
  return { ok: true };
}

export async function handleAgentsUpdate(
  payload: IpcMap['agents:update']['req'],
): Promise<IpcMap['agents:update']['res']> {
  const updated = updateAgent(payload.agentId, payload.patch);
  const repo = getRepo(updated.repoId);
  return decorate(updated, repo ? new Date(repo.connectedAt) : new Date());
}

export async function handleAgentsCreate(
  payload: IpcMap['agents:create']['req'],
): Promise<IpcMap['agents:create']['res']> {
  const handler = (() => {
    try {
      return getAgentHandler(payload.name);
    } catch {
      return null;
    }
  })();
  if (handler && !handler.multiInstance) {
    const existing = countAgentsByName(payload.repoId, payload.name);
    if (existing > 0) {
      throw new ObeliskError(
        'AGENT_SINGLETON',
        `Only one ${payload.name} instance is supported per repo.`,
        handler.addAnotherExplainer,
      );
    }
  }
  const created = createAgent({
    repoId: payload.repoId,
    name: payload.name,
    displayName: payload.displayName,
    runnerOverride: payload.runnerOverride ?? null,
    scheduleCron: payload.scheduleCron ?? null,
  });
  const repo = getRepo(created.repoId);
  return decorate(created, repo ? new Date(repo.connectedAt) : new Date());
}

export async function handleAgentsClone(
  payload: IpcMap['agents:clone']['req'],
): Promise<IpcMap['agents:clone']['res']> {
  const src = getAgent(payload.agentId);
  if (!src) throw new ObeliskError('AGENT_NOT_FOUND', `agent ${payload.agentId} not found`);
  const handler = (() => {
    try {
      return getAgentHandler(src.name);
    } catch {
      return null;
    }
  })();
  if (handler && !handler.multiInstance) {
    throw new ObeliskError(
      'AGENT_SINGLETON',
      `Only one ${src.name} instance is supported per repo.`,
      handler.addAnotherExplainer,
    );
  }
  const cloned = cloneAgentRow(payload.agentId);
  const repo = getRepo(cloned.repoId);
  return decorate(cloned, repo ? new Date(repo.connectedAt) : new Date());
}

export async function handleAgentsDelete(
  payload: IpcMap['agents:delete']['req'],
): Promise<IpcMap['agents:delete']['res']> {
  const agent = getAgent(payload.agentId);
  if (!agent) throw new ObeliskError('AGENT_NOT_FOUND', `agent ${payload.agentId} not found`);
  // Don't allow deletion while a live run is in flight — the run row's
  // foreign key would orphan and the user almost always wants to cancel
  // first explicitly.
  const live = listLiveRuns(agent.repoId).some((r) => r.agentId === agent.id);
  if (live) {
    throw new ObeliskError(
      'AGENT_BUSY',
      `${agent.displayName} has a live run. Wait for it to finish or pause the agent first.`,
    );
  }
  deleteAgentRow(payload.agentId);
  return { ok: true };
}

export async function handleAgentsReadMd(
  payload: IpcMap['agents:readMd']['req'],
): Promise<IpcMap['agents:readMd']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  return readAgentMd(repo.localPath, payload.agentName);
}
