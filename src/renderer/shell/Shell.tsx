import type { ReactElement, ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Titlebar } from './Titlebar';
import { TestPlanGenerationToast } from '../components/TestPlanGenerationToast';
import { RunStartedToast } from '../components/RunStartedToast';
import { CoverageFindingsToast } from '../components/CoverageFindingsToast';
import { AgentEnabledToast } from '../components/AgentEnabledToast';
import { AgentAutoPausedToast } from '../components/AgentAutoPausedToast';
import { RunnerAuthBanner } from '../components/RunnerAuthBanner';
import { GlobalAlert } from '../components/GlobalAlert';
import { GlobalConfirm } from '../components/GlobalConfirm';
import { GlobalFolderPicker } from '../components/GlobalFolderPicker';

interface Props {
  children: ReactNode;
}

export function Shell({ children }: Props): ReactElement {
  return (
    <div className="app-shell">
      <Titlebar />
      <Sidebar />
      <main className="main">
        <RunnerAuthBanner />
        <section className="screen">{children}</section>
      </main>
      <TestPlanGenerationToast />
      <RunStartedToast />
      <CoverageFindingsToast />
      <AgentEnabledToast />
      <AgentAutoPausedToast />
      <GlobalAlert />
      <GlobalConfirm />
      <GlobalFolderPicker />
    </div>
  );
}
