import { app, ipcMain } from 'electron';
import { fromException, ok, type Result } from '../../shared/errors';
import type { IpcChannel, IpcMap } from '../../shared/types';
import { dbPath } from '../db';
import {
  handleAuthStatus,
  handleAuthSignIn,
  handleAuthComplete,
  handleAuthUpgradeScope,
  handleAuthCapabilities,
  handleAuthSignInWithToken,
  handleAuthSignOut,
} from './auth';
import {
  handleReposList,
  handleReposConnect,
  handleReposSetMode,
  handleReposListGitHubRepos,
  handleReposBugFixerSettings,
} from './repos';
import { handleFsListDir } from './fs';
import { handleAllowlistList, handleAllowlistAdd, handleAllowlistRemove } from './allowlist';
import {
  handleAgentsList,
  handleAgentsRun,
  handleAgentsCancel,
  handleAgentsUpdate,
  handleAgentsCreate,
  handleAgentsClone,
  handleAgentsDelete,
  handleAgentsReadMd,
} from './agents';
import { handleBugFixerHealth } from './bug-fixer-health';
import {
  handleRunsList,
  handleRunsActiveForRepo,
  handleRunsGet,
  handleRunsStats,
  handleRunsHistogram,
  handleRunsRetry,
  handleRunsDelete,
  handleRunsDeleteCompleted,
  handleRunsArchive,
  handleRunsArchiveCompleted,
  handleArchiveList,
  handleArchiveCount,
  handleArchiveRestore,
  handleArchiveDeleteAll,
} from './runs';
import {
  handleBacklogList,
  handleBacklogReorder,
  handleBacklogSetOverride,
  handleBacklogRefresh,
} from './backlog';
import { handlePlaybookGet, handlePlaybookRegenerate, handlePlaybookSave } from './playbook';
import {
  handlePreviewsList,
  handlePreviewsGet,
  handlePreviewsFileIssue,
  handlePreviewsDismiss,
  handlePreviewsUndismiss,
  handlePreviewsRefresh,
  handlePreviewsCreateDraftFromCase,
  handlePreviewsRefine,
  handlePreviewsRefineAvailable,
  handlePreviewsListFollowups,
  handlePreviewsRevertFollowups,
} from './previews';
import {
  handleTestPlansList,
  handleTestPlansGet,
  handleTestPlansSave,
  handleTestPlansGenerate,
  handleTestPlansGenerationJobs,
  handleTestPlansDismissJob,
  handleTestPlansDelete,
} from './test-plans';
import {
  handleCoverageList,
  handleCoverageBootstrapMap,
  handleCoverageGenerateMap,
  handleCoverageGenerationJobs,
  handleCoverageDismissJob,
  handleCoverageCleanStaleLabels,
  handleCoverageStartLoop,
  handleCoverageCancelLoop,
  handleCoverageLoopStatus,
  handleCoverageLoopPreflight,
  handleCoverageGetSchedule,
  handleCoverageSetSchedule,
} from './coverage';
import {
  handleQaDoctor,
  handleQaDoctorSetup,
  handleQaGetConfig,
  handleQaList,
  handleQaPlan,
  handleQaReset,
  handleQaRunFlow,
  handleQaSaveConfig,
  handleQaWarmPool,
} from './qa';
import { handleSettingsGet, handleSettingsUpdate } from './settings';
import { handleModelsList } from './models';
import { handleRunnerProbeAuth, handleRunnersInstalled } from './runner';

type Handler<C extends IpcChannel> = (payload: IpcMap[C]['req']) => Promise<IpcMap[C]['res']>;

const handlers = new Map<IpcChannel, (payload: unknown) => Promise<unknown>>();

function register<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  handlers.set(channel, handler as (payload: unknown) => Promise<unknown>);
}

/**
 * Every IPC channel from `IpcMap` resolves to a real handler. Phases that
 * own each channel: auth/repos/allowlist (2), agents/runs (4), backlog (5),
 * playbook (5), settings (9).
 */
export function registerIpcHandlers(): void {
  register('system:info', async () => ({
    version: app.getVersion(),
    dbPath: dbPath(),
    userDataDir: app.getPath('userData'),
    node: process.versions.node,
    electron: process.versions.electron ?? '',
  }));

  // Auth (Phase 2 — real)
  register('auth:status', handleAuthStatus);
  register('auth:signIn', handleAuthSignIn);
  register('auth:complete', handleAuthComplete);
  register('auth:upgradeScope', handleAuthUpgradeScope);
  register('auth:capabilities', handleAuthCapabilities);
  register('auth:signInWithToken', handleAuthSignInWithToken);
  register('auth:signOut', handleAuthSignOut);

  // Repos (Phase 2 — real)
  register('repos:list', handleReposList);
  register('repos:connect', handleReposConnect);
  register('repos:setMode', handleReposSetMode);
  register('repos:bugFixerSettings', handleReposBugFixerSettings);
  register('repos:listGitHubRepos', handleReposListGitHubRepos);

  // Filesystem (read-only — drives the branded folder picker)
  register('fs:listDir', handleFsListDir);

  // Allowlist (Phase 2 — real)
  register('allowlist:list', handleAllowlistList);
  register('allowlist:add', handleAllowlistAdd);
  register('allowlist:remove', handleAllowlistRemove);

  // Agents (Phase 4 — real)
  register('agents:list', handleAgentsList);
  register('agents:run', handleAgentsRun);
  register('agents:cancel', handleAgentsCancel);
  register('agents:update', handleAgentsUpdate);
  register('agents:create', handleAgentsCreate);
  register('agents:clone', handleAgentsClone);
  register('agents:delete', handleAgentsDelete);
  register('agents:readMd', handleAgentsReadMd);
  register('bugFixer:health', handleBugFixerHealth);

  // Runs (Phase 4 — real)
  register('runs:list', handleRunsList);
  register('runs:activeForRepo', handleRunsActiveForRepo);
  register('runs:get', handleRunsGet);
  register('runs:stats', handleRunsStats);
  register('runs:histogram', handleRunsHistogram);
  register('runs:retry', handleRunsRetry);
  register('runs:delete', handleRunsDelete);
  register('runs:deleteCompleted', handleRunsDeleteCompleted);
  register('runs:archive', handleRunsArchive);
  register('runs:archiveCompleted', handleRunsArchiveCompleted);
  register('archive:list', handleArchiveList);
  register('archive:count', handleArchiveCount);
  register('archive:restore', handleArchiveRestore);
  register('archive:deleteAll', handleArchiveDeleteAll);

  // Backlog (Phase 4 — real)
  register('backlog:list', handleBacklogList);
  register('backlog:reorder', handleBacklogReorder);
  register('backlog:setOverride', handleBacklogSetOverride);
  register('backlog:refresh', handleBacklogRefresh);

  // Playbook
  register('playbook:get', handlePlaybookGet);
  register('playbook:save', handlePlaybookSave);
  register('playbook:regenerate', handlePlaybookRegenerate);

  // Observe-mode previews
  register('previews:list', handlePreviewsList);
  register('previews:get', handlePreviewsGet);
  register('previews:fileIssue', handlePreviewsFileIssue);
  register('previews:dismiss', handlePreviewsDismiss);
  register('previews:undismiss', handlePreviewsUndismiss);
  register('previews:refresh', handlePreviewsRefresh);
  register('previews:createDraftFromCase', handlePreviewsCreateDraftFromCase);
  register('previews:refine', handlePreviewsRefine);
  register('previews:refineAvailable', handlePreviewsRefineAvailable);
  register('previews:listFollowups', handlePreviewsListFollowups);
  register('previews:revertFollowups', handlePreviewsRevertFollowups);

  // Test plans (gate the QA agent run flow)
  register('testPlans:list', handleTestPlansList);
  register('testPlans:get', handleTestPlansGet);
  register('testPlans:save', handleTestPlansSave);
  register('testPlans:generate', handleTestPlansGenerate);
  register('testPlans:generationJobs', handleTestPlansGenerationJobs);
  register('testPlans:dismissJob', handleTestPlansDismissJob);
  register('testPlans:delete', handleTestPlansDelete);

  // Coverage map (Phase 12 — file × case × finding × churn report)
  register('coverage:list', handleCoverageList);
  register('coverage:bootstrapMap', handleCoverageBootstrapMap);
  register('coverage:generateMap', handleCoverageGenerateMap);
  register('coverage:generationJobs', handleCoverageGenerationJobs);
  register('coverage:dismissJob', handleCoverageDismissJob);
  register('coverage:cleanStaleLabels', handleCoverageCleanStaleLabels);

  // Coverage Agent — the autonomous map → gaps → draft → hunt loop.
  register('coverage:startLoop', handleCoverageStartLoop);
  register('coverage:cancelLoop', handleCoverageCancelLoop);
  register('coverage:loopStatus', handleCoverageLoopStatus);
  register('coverage:loopPreflight', handleCoverageLoopPreflight);
  register('coverage:getSchedule', handleCoverageGetSchedule);
  register('coverage:setSchedule', handleCoverageSetSchedule);

  // iOS QA Pilot
  register('qa:list', handleQaList);
  register('qa:plan', handleQaPlan);
  register('qa:reset', handleQaReset);
  register('qa:runFlow', handleQaRunFlow);
  register('qa:doctor', handleQaDoctor);
  register('qa:doctorSetup', handleQaDoctorSetup);
  register('qa:warmPool', handleQaWarmPool);
  register('qa:getConfig', handleQaGetConfig);
  register('qa:saveConfig', handleQaSaveConfig);

  // Settings (Phase 9 — real)
  register('settings:get', handleSettingsGet);
  register('settings:update', handleSettingsUpdate);

  // Models (dynamic discovery — CLI configs + live API + curated fallback)
  register('models:list', handleModelsList);

  // Runner sign-in probe (drives the auth banner's "Verify sign-in" button)
  register('runner:probeAuth', handleRunnerProbeAuth);
  register('runners:installed', handleRunnersInstalled);

  // Bind ipcMain.handle for every registered channel with a single envelope wrapper.
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, payload): Promise<Result<unknown>> => {
      try {
        const value = await handler(payload);
        return ok(value);
      } catch (e) {
        return fromException(e);
      }
    });
  }
}

export function unregisterIpcHandlers(): void {
  for (const channel of handlers.keys()) {
    ipcMain.removeHandler(channel);
  }
  handlers.clear();
}
