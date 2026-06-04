import { useState, type ReactElement } from 'react';
import { axisVertices, polygonPoints, toSvgPath } from '../../../shared/coverage-formula';
import { truncateLabel, useAnimatedValues } from './radar-helpers';
import type { CoverageFeature } from '../../../shared/types';

interface Props {
  features: CoverageFeature[];
  selectedLabel: string | null;
  onSelect: (label: string | null) => void;
  size?: number;
}

const RING_LEVELS = [25, 50, 75, 100];

/**
 * Hand-rolled SVG radar. Animates each axis value from its previous to its
 * new value (via the shared `useAnimatedValues` tween) whenever the `features`
 * array changes — the "axis growing outward after a run" effect the screen needs.
 *
 * Falls back to a horizontal bar list when fewer than 3 features are
 * available, since a 2-axis polygon collapses to a line.
 */
export function CoverageRadar({
  features,
  selectedLabel,
  onSelect,
  size = 360,
}: Props): ReactElement {
  const cx = size / 2;
  const cy = size / 2;
  // Shrink the polygon to leave generous room for axis labels (which can be
  // long words like "completion" or "renderer-screens"). Without this the
  // text-anchored labels overflow the SVG bounds and get clipped by the
  // container.
  const radius = Math.max(40, size / 2 - 88);

  const target = features.map((f) => f.coveragePct);
  const animated = useAnimatedValues(target);

  // Hovered axis index — drives the tooltip card overlaid above the radar.
  const [hover, setHover] = useState<number | null>(null);

  if (features.length < 3) {
    return (
      <CoverageBarList
        features={features}
        selectedLabel={selectedLabel}
        onSelect={onSelect}
        animated={animated}
      />
    );
  }

  const gridVerts = axisVertices(features.length, cx, cy, radius);
  const dataPoints = polygonPoints(animated, cx, cy, radius);

  return (
    <div className="coverage-radar-shell" style={{ width: size, height: size }}>
      <svg
        className="coverage-radar"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label="Coverage by feature"
      >
        {/* Grid rings */}
        {RING_LEVELS.map((level) => {
          const pts = axisVertices(features.length, cx, cy, (radius * level) / 100);
          return (
            <polygon
              key={`ring-${level}`}
              className="coverage-radar-ring"
              points={toSvgPath(pts)}
              fill="none"
            />
          );
        })}

        {/* Axis spokes */}
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

        {/* Data polygon */}
        <polygon className="coverage-radar-fill" points={toSvgPath(dataPoints)} />

        {/* Vertex dots */}
        {dataPoints.map((p, i) => {
          const f = features[i]!;
          const isSelected = selectedLabel === f.label;
          const isHover = hover === i;
          return (
            <circle
              key={`dot-${f.label}`}
              className={`coverage-radar-dot${isSelected ? ' selected' : ''}${
                isHover ? ' hover' : ''
              }`}
              cx={p[0]}
              cy={p[1]}
              r={isSelected || isHover ? 5 : 3.5}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onSelect(isSelected ? null : f.label)}
            />
          );
        })}

        {/* Axis labels — placed just outside the outer ring */}
        {gridVerts.map((p, i) => {
          const f = features[i]!;
          const labelOffset = 18;
          const dx = p[0] - cx;
          const dy = p[1] - cy;
          const norm = Math.sqrt(dx * dx + dy * dy) || 1;
          const lx = p[0] + (dx / norm) * labelOffset;
          const ly = p[1] + (dy / norm) * labelOffset;
          const anchor = lx < cx - 4 ? 'end' : lx > cx + 4 ? 'start' : 'middle';
          const isSelected = selectedLabel === f.label;
          // Horizontally-anchored labels only have ~70px of gutter before
          // they spill past the radar column into the summary card next
          // door. Center-anchored labels split that gutter both ways.
          // Truncate so the visible text always fits; the full label is
          // still available via the hover tooltip card above the radar.
          const truncated = truncateLabel(f.label, anchor === 'middle' ? 18 : 11);
          return (
            <g
              key={`label-${f.label}`}
              className={`coverage-radar-label${isSelected ? ' selected' : ''}`}
              transform={`translate(${lx} ${ly})`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onSelect(isSelected ? null : f.label)}
            >
              <text textAnchor={anchor} dy={-2} className="coverage-radar-label-text">
                {truncated}
                {truncated !== f.label ? <title>{f.label}</title> : null}
              </text>
              <text textAnchor={anchor} dy={11} className="coverage-radar-label-pct">
                {f.coveragePct}%
              </text>
            </g>
          );
        })}
      </svg>

      {hover !== null ? <RadarTooltip feature={features[hover]!} /> : null}
    </div>
  );
}

function RadarTooltip({ feature }: { feature: CoverageFeature }): ReactElement {
  return (
    <div className="coverage-radar-tip" role="tooltip">
      <div className="coverage-radar-tip-title">
        {feature.label} · <strong>{feature.coveragePct}%</strong>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Files w/ cases</span>
        <span>
          {feature.filesWithCases} / {feature.filesInGlob}
        </span>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Recent passes</span>
        <span>{feature.filesRecentPass}</span>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Cases passed</span>
        <span>
          {feature.casesPassed} / {feature.caseCount}
        </span>
      </div>
      <div className="coverage-radar-tip-row">
        <span>Open findings</span>
        <span className={feature.openFindings > 0 ? 'bad' : ''}>{feature.openFindings}</span>
      </div>
    </div>
  );
}

/** Horizontal-bar fallback when feature count is below the radar minimum. */
function CoverageBarList({
  features,
  selectedLabel,
  onSelect,
  animated,
}: Pick<Props, 'features' | 'selectedLabel' | 'onSelect'> & {
  animated: number[];
}): ReactElement {
  if (features.length === 0) {
    return (
      <div className="coverage-radar-empty">
        No features yet. Tag your test cases with labels and add them to{' '}
        <span className="mono">qa/coverage-map.md</span> to populate the radar.
      </div>
    );
  }
  return (
    <div className="coverage-radar-bars">
      {features.map((f, i) => {
        const v = animated[i] ?? 0;
        const isSelected = selectedLabel === f.label;
        return (
          <button
            type="button"
            key={f.label}
            className={`coverage-radar-bar${isSelected ? ' selected' : ''}`}
            onClick={() => onSelect(isSelected ? null : f.label)}
          >
            <div className="coverage-radar-bar-label">{f.label}</div>
            <div className="coverage-radar-bar-track">
              <div className="coverage-radar-bar-fill" style={{ width: `${v}%` }} />
            </div>
            <div className="coverage-radar-bar-pct">{f.coveragePct}%</div>
          </button>
        );
      })}
    </div>
  );
}
