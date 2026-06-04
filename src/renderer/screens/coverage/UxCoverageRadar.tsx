import { useState, type ReactElement } from 'react';
import { axisVertices, polygonPoints, toSvgPath } from '../../../shared/coverage-formula';
import { truncateLabel, useAnimatedValues } from './radar-helpers';
import type { UxSurface } from '../../../shared/types';

interface Props {
  surfaces: UxSurface[];
  selectedLabel: string | null;
  onSelect: (label: string | null) => void;
  size?: number;
}

const RING_LEVELS = [25, 50, 75, 100];

/**
 * UX coverage radar — one axis per surface, the axis value is the surface's
 * `coverageScore` (0 = unswept, 100 = swept & clean, in between = swept with
 * open UX debt). Mirrors the Test Coverage radar but with a UX-flavored
 * tooltip. Falls back to a bar list under 3 surfaces (a 2-axis polygon is a
 * line). Reuses the shared SVG geometry helpers.
 */
export function UxCoverageRadar({
  surfaces,
  selectedLabel,
  onSelect,
  size = 360,
}: Props): ReactElement {
  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(40, size / 2 - 88);

  const target = surfaces.map((s) => s.coverageScore);
  const animated = useAnimatedValues(target);
  const [hover, setHover] = useState<number | null>(null);

  if (surfaces.length < 3) {
    return (
      <UxBarList
        surfaces={surfaces}
        selectedLabel={selectedLabel}
        onSelect={onSelect}
        animated={animated}
      />
    );
  }

  const gridVerts = axisVertices(surfaces.length, cx, cy, radius);
  const dataPoints = polygonPoints(animated, cx, cy, radius);

  return (
    <div className="coverage-radar-shell" style={{ width: size, height: size }}>
      <svg
        className="coverage-radar"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label="UX coverage by surface"
      >
        {RING_LEVELS.map((level) => (
          <polygon
            key={`ring-${level}`}
            className="coverage-radar-ring"
            points={toSvgPath(axisVertices(surfaces.length, cx, cy, (radius * level) / 100))}
            fill="none"
          />
        ))}
        {gridVerts.map((p, i) => (
          <line
            key={`spoke-${i}`}
            className="coverage-radar-spoke"
            x1={cx}
            y1={cy}
            x2={p[0]}
            y2={p[1]}
          />
        ))}
        <polygon className="coverage-radar-fill" points={toSvgPath(dataPoints)} />
        {dataPoints.map((p, i) => {
          const s = surfaces[i]!;
          const isSelected = selectedLabel === s.label;
          const isHover = hover === i;
          return (
            <circle
              key={`dot-${s.label}`}
              className={`coverage-radar-dot${isSelected ? ' selected' : ''}${isHover ? ' hover' : ''}`}
              cx={p[0]}
              cy={p[1]}
              r={isSelected || isHover ? 5 : 3.5}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onSelect(isSelected ? null : s.label)}
            />
          );
        })}
        {gridVerts.map((p, i) => {
          const s = surfaces[i]!;
          const labelOffset = 18;
          const dx = p[0] - cx;
          const dy = p[1] - cy;
          const norm = Math.sqrt(dx * dx + dy * dy) || 1;
          const lx = p[0] + (dx / norm) * labelOffset;
          const ly = p[1] + (dy / norm) * labelOffset;
          const anchor = lx < cx - 4 ? 'end' : lx > cx + 4 ? 'start' : 'middle';
          const isSelected = selectedLabel === s.label;
          const truncated = truncateLabel(s.label, anchor === 'middle' ? 18 : 11);
          return (
            <g
              key={`label-${s.label}`}
              className={`coverage-radar-label${isSelected ? ' selected' : ''}`}
              transform={`translate(${lx} ${ly})`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onSelect(isSelected ? null : s.label)}
            >
              <text textAnchor={anchor} dy={-2} className="coverage-radar-label-text">
                {truncated}
                {truncated !== s.label ? <title>{s.label}</title> : null}
              </text>
              <text textAnchor={anchor} dy={11} className="coverage-radar-label-pct">
                {s.coverageScore}%
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null ? <UxRadarTooltip surface={surfaces[hover]!} /> : null}
    </div>
  );
}

function UxRadarTooltip({ surface }: { surface: UxSurface }): ReactElement {
  return (
    <div className="coverage-radar-tip" role="tooltip">
      <div className="coverage-radar-tip-title">
        {surface.label} · <strong>{surface.coverageScore}%</strong>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Status</span>
        <span>{surface.swept ? 'Swept' : 'Not swept'}</span>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Open findings</span>
        <span className={surface.openFindings > 0 ? 'bad' : ''}>{surface.openFindings}</span>
      </div>
      <div className="coverage-radar-tip-row">
        <span>By severity</span>
        <span>
          {surface.bySeverity.P0}·{surface.bySeverity.P1}·{surface.bySeverity.P2}
        </span>
      </div>
    </div>
  );
}

function UxBarList({
  surfaces,
  selectedLabel,
  onSelect,
  animated,
}: Pick<Props, 'surfaces' | 'selectedLabel' | 'onSelect'> & { animated: number[] }): ReactElement {
  if (surfaces.length === 0) {
    return (
      <div className="coverage-radar-empty">
        No surfaces yet. Generate the coverage map on the <strong>Test Coverage</strong> tab to
        populate the UX radar.
      </div>
    );
  }
  return (
    <div className="coverage-radar-bars">
      {surfaces.map((s, i) => {
        const v = animated[i] ?? 0;
        const isSelected = selectedLabel === s.label;
        return (
          <button
            type="button"
            key={s.label}
            className={`coverage-radar-bar${isSelected ? ' selected' : ''}`}
            onClick={() => onSelect(isSelected ? null : s.label)}
          >
            <div className="coverage-radar-bar-label">{s.label}</div>
            <div className="coverage-radar-bar-track">
              <div className="coverage-radar-bar-fill" style={{ width: `${v}%` }} />
            </div>
            <div className="coverage-radar-bar-pct">{s.coverageScore}%</div>
          </button>
        );
      })}
    </div>
  );
}
