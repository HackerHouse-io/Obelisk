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
import { pickWorstCoveragePlanId } from '../coverage/pick-plan';
import { getPatchAgentCap, isPatchAgent } from '../scheduler/patch-agent-cap';
import type { Agent, AgentName, IpcMap, RunnerKind } from '../../shared/types';
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
  // If the caller didn't specify a task, fall back to the agent's saved
  // default plan. The Agents screen exposes a "Default test plan" dropdown
  // that writes this — clicking Run now then dispatches that plan.
  let effectiveTaskId =
    payload.taskId ?? (agent.defaultPlanId ? `plan:${agent.defaultPlanId}` : undefined);
  // For QA agents with no explicit task and no bound default, pick the plan
  // whose feature has the lowest coverage (worst-first) — same rule as the
  // scheduler — so Run now never errors with "Multiple test plans exist".
  if (effectiveTaskId === undefined) {
    const handler = getAgentHandler(agent.name);
    if (handler.requiresTestPlan) {
      const repo = getRepo(agent.repoId);
      if (repo) {
        const planId = await pickWorstCoveragePlanId(repo, agent.name);
        if (planId) effectiveTaskId = `plan:${planId}`;
      }
    }
  }
  return dispatchAgentRun(agent, {
    ...(effectiveTaskId !== undefined ? { taskId: effectiveTaskId } : {}),
    ...(payload.runnerOverride ? { runnerOverride: payload.runnerOverride } : {}),
    ...(payload.modelOverride !== undefined ? { modelOverride: payload.modelOverride } : {}),
  });
}

/**
 * Shared dispatch core for `agents:run` and `runs:retry`. Runs the publish
 * pre-flight checks, then drives the run in the background and resolves as
 * soon as the run row exists (the orchestrator fires `onStarted` right after
 * createRun) — never waiting for the (minutes-long) CLI invocation.
 */
export async function dispatchAgentRun(
  agent: Agent,
  opts: {
    taskId?: string;
    forceTask?: boolean;
    retryOfRunId?: string;
    runnerOverride?: RunnerKind;
    modelOverride?: string;
    userClarification?: string;
  },
): Promise<IpcMap['agents:run']['res']> {
  await ensureRunnerAvailable();

  // Pre-flight: refuse to dispatch a run that's guaranteed to fail at publish.
  // Bug Fixer / Feature Builder produce patches; the publisher needs commit +
  // push + open_pr permissions, which the `observe` and `issues` safety modes
  // block. Fail-fast here with an actionable hint instead of burning minutes
  // of tokens and getting rejected at the very end with MODE_TOO_LOW.
  const handler = getAgentHandler(agent.name);
  const repo = getRepo(agent.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${agent.repoId} not found`);
  assertModeAllowsAgent(repo, handler, agent.displayName);

  // Per-repo cap on patch-producing multi-instance agents.
  if (handler.multiInstance && isPatchAgent(agent.name)) {
    const liveCount = listLiveRuns(agent.repoId).filter((r) => r.agentName === agent.name).length;
    assertPatchAgentCap(agent.repoId, agent.name, agent.displayName, liveCount);
  }

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
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      ...(opts.forceTask ? { forceTask: true } : {}),
      ...(opts.retryOfRunId ? { retryOfRunId: opts.retryOfRunId } : {}),
      ...(opts.runnerOverride ? { runnerOverride: opts.runnerOverride } : {}),
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.userClarification ? { userClarification: opts.userClarification } : {}),
      onStarted: ({ runId, taskRef, taskContext }) =>
        settle(() => resolve({ runId, taskRef, taskContext })),
    }).then(
      (result) => {
        // selectTask returned null (or another path that completed without
        // firing onStarted). Surface as NOT_FOUND so the renderer shows a
        // useful message instead of a stuck spinner.
        settle(() =>
          result.runId
            ? resolve({ runId: result.runId, taskRef: null, taskContext: null })
            : reject(
                new ObeliskError('NOT_FOUND', result.reason ?? 'No task to work on right now.'),
              ),
        );
      },
      (err) => {
        // Pre-onStarted failure: ObeliskErrors flow through unchanged.
        settle(() => reject(err));
      },
    );
  });
}

/**
 * Throw MODE_TOO_LOW when the repo's safety mode can't satisfy the
 * publish actions a producesPatch agent will need (commit / push /
 * open_pr). Pure function — exported for unit testing.
 */
/**
 * Throw PATCH_AGENT_CAP_REACHED when the per-repo concurrency cap for
 * bug-fixer / feature-builder is already met. Pure function — exported
 * for unit testing. The cap itself is sourced from
 * `scheduler/patch-agent-cap.ts` so tick.ts and the IPC stay aligned.
 */
export function assertPatchAgentCap(
  repoId: string,
  agentName: AgentName,
  agentDisplayName: string,
  liveCount: number,
): void {
  const cap = getPatchAgentCap(repoId);
  if (liveCount < cap) return;
  const noun = agentName === 'feature-builder' ? 'Feature Builders' : 'Bug Fixers';
  throw new ObeliskError(
    'PATCH_AGENT_CAP_REACHED',
    `${cap} ${noun} are already running on this repo — that's the per-repo cap.`,
    `Wait for one to finish, or raise this repo's "bug_fixer_cap" setting if you want more in parallel. The cap exists to stay under GitHub's secondary rate limits and to keep CI from thrashing.`,
  );
}

export function assertModeAllowsAgent(
  repo: { mode: import('../../shared/types').SafetyMode; githubFullName: string },
  handler: { producesPatch: boolean },
  agentDisplayName: string,
): void {
  if (!handler.producesPatch) return;
  if (repo.mode === 'prs' || repo.mode === 'automerge') return;
  throw new ObeliskError(
    'MODE_TOO_LOW',
    `${agentDisplayName} produces pull requests, but ${repo.githubFullName} is in safety mode "${repo.mode}".`,
    `Open Settings → Safety mode and switch this repo to "Fix & build" (PRs allowed) or higher before running ${agentDisplayName}.`,
  );
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
