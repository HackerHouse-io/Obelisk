import type { ReactElement } from 'react';

interface Props {
  size?: number;
  glow?: boolean;
}

export function ObeliskMark({ size = 18, glow = false }: Props): ReactElement {
  return (
    <svg width={size} height={size * 1.4} viewBox="0 0 20 28" fill="none">
      <defs>
        <linearGradient id="ob-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(82% 0.15 286)" />
          <stop offset="100%" stopColor="oklch(58% 0.18 286)" />
        </linearGradient>
      </defs>
      <path
        d="M10 1L7 5v18h6V5L10 1z"
        fill="url(#ob-grad)"
        stroke="oklch(85% 0.10 286)"
        strokeWidth="0.5"
      />
      <path d="M6 23h8v3H6z" fill="oklch(40% 0.10 286)" />
      <path d="M10 1L7 5h6L10 1z" fill="oklch(90% 0.10 286)" opacity="0.6" />
      {glow && (
        <circle
          cx="10"
          cy="14"
          r="11"
          fill="oklch(67% 0.17 286)"
          opacity="0.18"
          filter="blur(6px)"
        />
      )}
    </svg>
  );
}
