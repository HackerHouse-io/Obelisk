import { ObeliskError } from '../../shared/errors';
import { getRepo } from '../db/repos';
import { generateTestPlan } from '../test-plans/generate';
import { deletePlan, getPlan, listPlans, savePlan } from '../test-plans/store';
import { broadcast } from './bus';
import type { IpcMap } from '../../shared/types';

function repoOrThrow(repoId: string) {
  const repo = getRepo(repoId);
  if (!repo) throw new ObeliskError('REPO_NOT_FOUND', `repo ${repoId} not found`);
  return repo;
}

export async function handleTestPlansList(
  payload: IpcMap['testPlans:list']['req'],
): Promise<IpcMap['testPlans:list']['res']> {
  const repo = repoOrThrow(payload.repoId);
  return listPlans(repo.localPath, payload.agentName);
}

export async function handleTestPlansGet(
  payload: IpcMap['testPlans:get']['req'],
): Promise<IpcMap['testPlans:get']['res']> {
  const repo = repoOrThrow(payload.repoId);
  return getPlan(repo.localPath, payload.planId);
}

export async function handleTestPlansSave(
  payload: IpcMap['testPlans:save']['req'],
): Promise<IpcMap['testPlans:save']['res']> {
  const repo = repoOrThrow(payload.repoId);
  const saved = savePlan({
    repoPath: repo.localPath,
    planId: payload.planId,
    blocks: payload.blocks,
    ...(payload.name ? { name: payload.name } : {}),
  });
  broadcast({ type: 'testPlans.changed', repoId: repo.id });
  return { savedAt: saved.updatedAt };
}

export async function handleTestPlansGenerate(
  payload: IpcMap['testPlans:generate']['req'],
): Promise<IpcMap['testPlans:generate']['res']> {
  const repo = repoOrThrow(payload.repoId);
  if (payload.scope === 'feature' && !payload.featureName?.trim()) {
    throw new ObeliskError(
      'INVALID_INPUT',
      'A feature name is required for feature-scoped plans.',
    );
  }
  const plan = await generateTestPlan({
    repo,
    agentName: payload.agentName,
    scope: payload.scope,
    ...(payload.featureName ? { featureName: payload.featureName } : {}),
  });
  broadcast({ type: 'testPlans.changed', repoId: repo.id });
  return { planId: plan.frontmatter.id };
}

export async function handleTestPlansDelete(
  payload: IpcMap['testPlans:delete']['req'],
): Promise<IpcMap['testPlans:delete']['res']> {
  const repo = repoOrThrow(payload.repoId);
  deletePlan(repo.localPath, payload.planId);
  broadcast({ type: 'testPlans.changed', repoId: repo.id });
  return { ok: true };
}
