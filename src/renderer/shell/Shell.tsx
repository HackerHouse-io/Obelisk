import type { ReactElement, ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Titlebar } from './Titlebar';

interface Props {
  children: ReactNode;
}

export function Shell({ children }: Props): ReactElement {
  return (
    <div className="app-shell">
      <Titlebar />
      <Sidebar />
      <main className="main">
        <section className="screen">{children}</section>
      </main>
    </div>
  );
}
