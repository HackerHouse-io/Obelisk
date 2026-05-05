import type { CSSProperties, ReactElement, ReactNode } from 'react';

export type IconProps = {
  size?: number;
  color?: string;
  style?: CSSProperties;
  title?: string;
};

type IconRenderer = ((props: IconProps) => ReactElement) & { displayName?: string };

function make(children: ReactNode, viewBox = '0 0 16 16'): IconRenderer {
  const Component: IconRenderer = ({ size = 14, color = 'currentColor', style, title }) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
  Component.displayName = 'Icon';
  return Component;
}

export const Icon = {
  // navigation
  Home: make(
    <>
      <path d="M2.5 7.5L8 3l5.5 4.5" />
      <path d="M3.5 7v6h9V7" />
    </>,
  ),
  Pipeline: make(
    <>
      <circle cx="3.5" cy="8" r="1.5" />
      <circle cx="12.5" cy="8" r="1.5" />
      <path d="M5 8h6" />
      <path d="M3.5 4v8M12.5 4v8" opacity=".5" />
    </>,
  ),
  Backlog: make(<path d="M3 4h10M3 8h10M3 12h6" />),
  Agents: make(
    <>
      <rect x="3" y="3" width="10" height="10" rx="2" />
      <circle cx="6" cy="7" r="1" />
      <circle cx="10" cy="7" r="1" />
      <path d="M6 10.5h4" />
    </>,
  ),
  Playbook: make(
    <>
      <path d="M3.5 2.5h7l2 2v9h-9z" />
      <path d="M5 6h6M5 8.5h6M5 11h4" />
    </>,
  ),
  Settings: make(
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
    </>,
  ),
  Connect: make(
    <>
      <path d="M6 10l4-4" />
      <path d="M9 4l1-1a2.5 2.5 0 113.5 3.5L12 8" />
      <path d="M7 12l-1 1a2.5 2.5 0 11-3.5-3.5L4 8" />
    </>,
  ),
  Phone: make(
    <>
      <rect x="4" y="1.5" width="8" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
      <path d="M5.5 3.5h5" opacity=".5" />
    </>,
  ),

  // ui actions
  Search: make(
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13 13" />
    </>,
  ),
  Plus: make(<path d="M8 3v10M3 8h10" />),
  Close: make(<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />),
  Help: make(
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.2c.2-1 1.0-1.7 1.9-1.7 1.0 0 1.9.8 1.9 1.8 0 .9-.6 1.4-1.4 1.8-.5.2-.6.5-.6 1" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
    </>,
  ),
  Chevron: make(<path d="M6 4l4 4-4 4" />),
  ChevronDown: make(<path d="M4 6l4 4 4-4" />),
  Check: make(<path d="M3 8.5l3.5 3.5L13 4.5" />),
  Dot: make(<circle cx="8" cy="8" r="1.5" fill="currentColor" />),
  Drag: make(
    <>
      <circle cx="6" cy="4" r="0.8" fill="currentColor" />
      <circle cx="10" cy="4" r="0.8" fill="currentColor" />
      <circle cx="6" cy="8" r="0.8" fill="currentColor" />
      <circle cx="10" cy="8" r="0.8" fill="currentColor" />
      <circle cx="6" cy="12" r="0.8" fill="currentColor" />
      <circle cx="10" cy="12" r="0.8" fill="currentColor" />
    </>,
  ),
  Pin: make(<path d="M9.5 2.5l4 4-2 1-1.5 4-1.5-1.5L4 14l3-4.5L5.5 8l4-1.5z" />),
  Filter: make(<path d="M2.5 4h11M5 8h6M7 12h2" />),
  More: make(
    <>
      <circle cx="4" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </>,
  ),
  Play: make(<path d="M5 3.5v9l7-4.5z" fill="currentColor" />),
  Pause: make(
    <>
      <rect x="4" y="3.5" width="3" height="9" fill="currentColor" />
      <rect x="9" y="3.5" width="3" height="9" fill="currentColor" />
    </>,
  ),
  Refresh: make(
    <>
      <path d="M2.5 8a5.5 5.5 0 019.5-3.8M13.5 8a5.5 5.5 0 01-9.5 3.8" />
      <path d="M12 2v3h-3M4 14v-3h3" />
    </>,
  ),

  // status / domain
  Bug: make(
    <>
      <rect x="4.5" y="5" width="7" height="7" rx="3" />
      <path d="M2 8h2.5M11.5 8H14M3 5l1.5-1M13 5l-1.5-1M3 11l1.5 1M13 11l-1.5 1M8 5V3.5" />
    </>,
  ),
  Sparkles: make(
    <>
      <path d="M8 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M12.5 9.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
    </>,
  ),
  PR: make(
    <>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M4 5.5v5" />
      <path d="M12 10.5V8a2 2 0 00-2-2H7" />
      <path d="M9 4l-2 2 2 2" />
    </>,
  ),
  Issue: make(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </>,
  ),
  Eye: make(
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.5" />
    </>,
  ),
  EyeOff: make(
    <>
      <path d="M2.5 4l11 8M3 9.5C4.5 11 6 12 8 12c.7 0 1.4-.1 2-.3M14 8s-1-1.7-2.7-3M6 4.4C6.6 4.3 7.3 4.2 8 4.2c4 0 6.5 4.5 6.5 4.5" />
    </>,
  ),
  Shield: make(<path d="M8 1.5l5 2v4c0 3-2 5.5-5 7-3-1.5-5-4-5-7v-4z" />),
  GitHub: make(
    <path
      d="M8 1.5C4.4 1.5 1.5 4.4 1.5 8c0 2.9 1.9 5.3 4.4 6.2.3.1.4-.1.4-.3v-1.1c-1.8.4-2.2-.8-2.2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.7.1 1 .7 1 .7.6 1 1.5.7 1.9.6 0-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.3-1.3.7-1.7-.1-.2-.3-.9.1-1.8 0 0 .6-.2 1.8.7.5-.1 1.1-.2 1.6-.2s1.1.1 1.6.2c1.2-.8 1.8-.7 1.8-.7.4.9.1 1.6.1 1.8.4.5.7 1 .7 1.7 0 2.5-1.5 3-3 3.2.2.2.4.6.4 1.2v1.7c0 .2.1.4.4.3 2.6-.9 4.4-3.3 4.4-6.2 0-3.6-2.9-6.5-6.5-6.5z"
      fill="currentColor"
      stroke="none"
    />,
  ),
  Branch: make(
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 5v6" />
      <path d="M12 7.5c0 2-2 3-4 3" />
    </>,
  ),
  Clock: make(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>,
  ),
  Doc: make(
    <>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </>,
  ),
  Folder: make(<path d="M2 4.5h4l1 1.5h7v7H2z" />),
  Code: make(<path d="M5 5l-3 3 3 3M11 5l3 3-3 3M9.5 4l-3 8" />),
  Camera: make(
    <>
      <rect x="2" y="4.5" width="12" height="8.5" rx="1.5" />
      <circle cx="8" cy="8.7" r="2" />
      <path d="M5.5 4.5l1-1.5h3l1 1.5" />
    </>,
  ),
  Terminal: make(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l1.5 1.5L5 10M8 10h3" />
    </>,
  ),
  Lock: make(
    <>
      <rect x="3.5" y="7" width="9" height="6" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>,
  ),
  Spark: make(<path d="M8 2v4M8 10v4M2 8h4M10 8h4" />),
  AlertTri: make(
    <>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 7v3M8 12v.01" />
    </>,
  ),
  ArrowRight: make(<path d="M3 8h10M9 4l4 4-4 4" />),
  ArrowDown: make(<path d="M8 3v10M4 9l4 4 4-4" />),
  External: make(
    <>
      <path d="M6 3H3v10h10V10" />
      <path d="M9 3h4v4M13 3l-6 6" />
    </>,
  ),
  Sliders: make(
    <>
      <path d="M3 4h10M3 8h10M3 12h10" />
      <circle cx="6" cy="4" r="1.5" fill="var(--bg-2)" />
      <circle cx="10" cy="8" r="1.5" fill="var(--bg-2)" />
      <circle cx="5" cy="12" r="1.5" fill="var(--bg-2)" />
    </>,
  ),
  PanelRight: make(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </>,
  ),
  Spinner: make(
    <>
      <path d="M8 1.5v3" opacity="1" />
      <path d="M8 11.5v3" opacity=".15" />
      <path d="M14.5 8h-3" opacity=".4" />
      <path d="M4.5 8h-3" opacity=".7" />
      <path d="M12.6 3.4l-2.1 2.1" opacity=".25" />
      <path d="M5.5 10.5l-2.1 2.1" opacity=".55" />
      <path d="M12.6 12.6l-2.1-2.1" opacity=".85" />
      <path d="M5.5 5.5L3.4 3.4" opacity=".95" />
    </>,
  ),
} as const satisfies Record<string, IconRenderer>;

export type IconName = keyof typeof Icon;
