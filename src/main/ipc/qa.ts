import { getRepo } from '../db/repos';
import {
  getSetupAt,
  listFlows,
  listMigrationsForRepo,
  resetFlows,
  type QaFlowRow,
} from '../db/qa-flows';
import { loadIosConfig } from '../agents/ios-qa-pilot/config';
import { keepBooted } from '../agents/ios-qa-pilot/sim-pool';
import { runDoctor, runSetup } from '../agents/ios-qa-pilot/doctor';
import { runAgent } from '../orchestrator/run';
import { broadcast } from './bus';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap, QaFlow } from '../../shared/types';

function toQaFlow(row: QaFlowRow, migrations: Map<string, string>): QaFlow {
  const flow: QaFlow = {
    flowId: row.flowId,
    repoId: row.repoId,
    title: row.title,
    sourcePath: row.sourcePath,
    status: row.status,
    cycle: row.cycle,
    lastRunId: row.lastRunId,
    lastVerifiedAt: row.lastVerifiedAt,
    findingCount: row.findingCount,
  };
  const renamed = migrations.get(row.flowId);
  if (renamed) flow.renamedFromOldId = renamed;
  return flow;
}

export async function handleQaList(
  payload: IpcMap['qa:list']['req'],
): Promise<IpcMap['qa:list']['res']> {
  const rows = listFlows(payload.repoId);
  const migrations = listMigrationsForRepo(payload.repoId);
  const map = new Map(migrations.map((m) => [m.newId, m.oldId]));
  return rows.map((r) => toQaFlow(r, map));
}

export async function handleQaPlan(
  payload: IpcMap['qa:plan']['req'],
): Promise<IpcMap['qa:plan']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const cfg = loadIosConfig(repo.localPath);
  const flows = listFlows(payload.repoId);
  const claimable = flows.filter((f) => f.status !== 'running' && f.status !== 'passed').length;
  const target = Math.min(cfg.maxParallel, claimable);
  if (target === 0) return { enqueued: 0, runIds: [], reason: 'nothing claimable' };

  const runIds: string[] = [];
  for (let i = 0; i < target; i++) {
    const result = await runAgent({
      repoId: payload.repoId,
      agentName: 'ios-qa-pilot',
      trigger: 'manual',
    });
    if (result.runId) runIds.push(result.runId);
  }
  return { enqueued: runIds.length, runIds };
}

export async function handleQaReset(
  payload: IpcMap['qa:reset']['req'],
): Promise<IpcMap['qa:reset']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const result = resetFlows(payload.repoId, payload.scope ?? 'unverified');
  for (const f of listFlows(payload.repoId)) {
    broadcast({ type: 'qa.flowChanged', repoId: payload.repoId, flowId: f.flowId });
  }
  return result;
}

export async function handleQaRunFlow(
  payload: IpcMap['qa:runFlow']['req'],
): Promise<IpcMap['qa:runFlow']['res']> {
  const result = await runAgent({
    repoId: payload.repoId,
    agentName: 'ios-qa-pilot',
    trigger: 'manual',
    taskId: `flow:${payload.flowId}`,
  });
  if (!result.runId) {
    throw new ObeliskError(
      'NOT_FOUND',
      result.reason ?? 'Could not start a run for this flow (already running, or pool full).',
    );
  }
  return { runId: result.runId };
}

export async function handleQaDoctor(
  payload: IpcMap['qa:doctor']['req'],
): Promise<IpcMap['qa:doctor']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const cfg = loadIosConfig(repo.localPath);
  const report = await runDoctor({
    repoId: payload.repoId,
    poolSize: cfg.maxParallel,
    appiumPortBase: cfg.appiumPortBase,
    wdaPortBase: cfg.wdaPortBase,
    device: cfg.simulatorDevice,
    os: cfg.simulatorOs || undefined,
  });
  return { ...report, setupAt: getSetupAt(payload.repoId) };
}

export async function handleQaDoctorSetup(
  payload: IpcMap['qa:doctorSetup']['req'],
): Promise<IpcMap['qa:doctorSetup']['res']> {
  const repo = getRepo(payload.repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${payload.repoId} not found`);
  const cfg = loadIosConfig(repo.localPath);
  const report = await runSetup({
    repoId: payload.repoId,
    poolSize: cfg.maxParallel,
    appiumPortBase: cfg.appiumPortBase,
    wdaPortBase: cfg.wdaPortBase,
    device: cfg.simulatorDevice,
    os: cfg.simulatorOs || undefined,
  });
  broadcast({ type: 'qa.doctorChanged', repoId: payload.repoId });
  return { ...report, setupAt: getSetupAt(payload.repoId) };
}

export async function handleQaWarmPool(): Promise<IpcMap['qa:warmPool']['res']> {
  await keepBooted();
  return { ok: true };
}
