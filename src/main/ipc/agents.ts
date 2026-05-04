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
import type { Agent, IpcMap } from '../../shared/types';
import { readAgentMd } from '../agents/skill-loader';

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
  const result = await runAgent({
    repoId: agent.repoId,
    agentName: agent.name,
    agentId: agent.id,
    trigger: 'manual',
    taskId: payload.taskId,
  });
  if (!result.runId) {
    throw new ObeliskError('NOT_FOUND', result.reason ?? 'No task to work on right now.');
  }
  return { runId: result.runId };
}

export async function handleAgentsCancel(
  _payload: IpcMap['agents:cancel']['req'],
): Promise<IpcMap['agents:cancel']['res']> {
  throw new ObeliskError(
    'NOT_IMPLEMENTED',
    'Cancel mid-run lands in Phase 10 alongside the scheduler.',
  );
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
