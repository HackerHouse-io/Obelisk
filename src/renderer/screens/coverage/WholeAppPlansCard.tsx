import { type ReactElement } from 'react';
import { findActiveRun, RunRow, type ActiveRun, type RunnerInstalled } from './FeatureCard';
import type { AgentName, TestPlanRef } from '../../../shared/types';

interface Props {
  repoId: string;
  plans: TestPlanRef[];
  installed: RunnerInstalled | null;
  activeRuns: ActiveRun[];
  onChange: () => void;
}

/**
 * Row of whole-app QA plans (frontmatter.scope === 'whole-app'). Each plan
 * surfaces as a sub-row per declared agent — same RunRow used on feature
 * cards, so model selection + running-state behave identically. Hidden
 * entirely when no whole-app plans exist.
 */
export function WholeAppPlansCard({
  repoId,
  plans,
  installed,
  activeRuns,
  onChange,
}: Props): ReactElement | null {
  if (plans.length === 0) return null;
  const runnersOk = installed ? installed.claude.installed || installed.codex.installed : null;
  const runnersHint =
    installed && !runnersOk
      ? (installed.claude.hint ?? installed.codex.hint ?? 'No coding-agent CLI on PATH.')
      : null;

  const rows: { plan: TestPlanRef; agentName: AgentName }[] = [];
  for (const plan of plans) {
    for (const agentName of plan.agentNames) {
      rows.push({ plan, agentName });
    }
  }

  return (
    <div className="coverage-whole-app-card" data-testid="coverage-whole-app-card">
      <div className="coverage-whole-app-card-head">
        <div className="coverage-whole-app-card-title">Whole-app QA</div>
        <div className="coverage-whole-app-card-sub">
          Plans that sweep across the entire repo, not scoped to a single feature.
        </div>
      </div>
      <div className="coverage-whole-app-card-runs">
        {rows.map(({ plan, agentName }) => (
          <RunRow
            key={`${plan.id}:${agentName}`}
            repoId={repoId}
            featureLabel="whole-app"
            plan={plan}
            agentName={agentName}
            installed={installed}
            runnersOk={runnersOk}
            runnersHint={runnersHint}
            activeRun={findActiveRun(activeRuns, plan.id, agentName)}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}
