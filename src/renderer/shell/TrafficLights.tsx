import type { CSSProperties, ReactElement } from 'react';

/**
 * Decorative macOS traffic-light dots. The real window controls are
 * provided by Electron's `titleBarStyle: 'hiddenInset'`; this component
 * only renders inside non-mac titlebars or in design previews.
 */
export function TrafficLights(): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={dotStyle('#ff5f57')} />
      <span style={dotStyle('#febc2e')} />
      <span style={dotStyle('#28c840')} />
    </div>
  );
}

function dotStyle(background: string): CSSProperties {
  return {
    width: 12,
    height: 12,
    borderRadius: '50%',
    background,
    boxShadow: '0 0 0 0.5px rgba(0,0,0,0.4) inset',
  };
}
