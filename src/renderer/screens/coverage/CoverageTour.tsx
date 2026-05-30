import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { Icon } from '../../icons';

/**
 * A lightweight, dependency-free guided tour for the Coverage screen.
 *
 * Each step optionally anchors to a real element (by `data-testid`). When the
 * element is on screen the tour dims everything else and spotlights it; when
 * the element is absent (e.g. a fresh repo with no feature cards yet) the step
 * gracefully falls back to a centered card so the tour can never break or get
 * stuck. Robustness over flash — this is the first thing a new user sees.
 */

export interface TourStep {
  /** data-testid of the element to spotlight. Omit for a centered step. */
  targetTestId?: string;
  title: string;
  body: string;
}

interface Props {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
}

const PAD = 8; // spotlight padding around the target
const CARD_W = 340;

export function CoverageTour({ steps, open, onClose }: Props): ReactElement | null {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Restart at step 0 every time the tour is (re)opened.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  // Re-read the target's rect (cheap — no scrolling). Used by the resize /
  // scroll listeners so the spotlight stays glued to a moving target.
  const recalc = useCallback(() => {
    const id = open ? steps[idx]?.targetTestId : undefined;
    const el = id ? document.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null;
    setRect(el ? el.getBoundingClientRect() : null);
  }, [steps, idx, open]);

  // On step change, bring the target into view ONCE, then measure. Scrolling
  // lives here, not in `recalc`, so the listeners below never fight the user's
  // scroll or loop on their own smooth-scroll.
  useLayoutEffect(() => {
    const id = open ? steps[idx]?.targetTestId : undefined;
    const el = id ? document.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null;
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const raf = requestAnimationFrame(recalc);
    return () => cancelAnimationFrame(raf);
  }, [steps, idx, open, recalc]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, true);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [open, recalc]);

  const last = idx >= steps.length - 1;
  const next = useCallback(() => {
    if (last) onClose();
    else setIdx((i) => Math.min(i + 1, steps.length - 1));
  }, [last, onClose, steps.length]);
  const back = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  // Keyboard: Esc dismisses, arrows / Enter navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, back, onClose]);

  if (!open || steps.length === 0) return null;
  const step = steps[idx]!;

  // Spotlight box (when anchored to a real element).
  const spotlight = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  const cardStyle = cardStyleFor(rect);

  return (
    <div className="coverage-tour" data-testid="coverage-tour" role="dialog" aria-modal="true">
      {spotlight ? (
        <div className="coverage-tour-spotlight" style={spotlight} />
      ) : (
        <div className="coverage-tour-scrim" onClick={onClose} />
      )}

      <div className="coverage-tour-card" style={cardStyle} data-testid="coverage-tour-card">
        <div className="coverage-tour-card-head">
          <span className="coverage-tour-step-count">
            {idx + 1} / {steps.length}
          </span>
          <button
            type="button"
            className="coverage-tour-skip"
            onClick={onClose}
            data-testid="coverage-tour-skip"
          >
            Skip
          </button>
        </div>
        <div className="coverage-tour-title">{step.title}</div>
        <div className="coverage-tour-body">{step.body}</div>
        <div className="coverage-tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={`coverage-tour-dot${i === idx ? ' active' : ''}`} />
          ))}
        </div>
        <div className="coverage-tour-actions">
          {idx > 0 ? (
            <button type="button" className="btn sm" onClick={back}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn sm primary"
            onClick={next}
            data-testid="coverage-tour-next"
          >
            {last ? (
              <>
                <Icon.Check size={11} /> Got it
              </>
            ) : (
              <>
                Next <Icon.ArrowRight size={11} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Place the card near the target (below if it fits, else above), or center it
 *  for an unanchored step. */
function cardStyleFor(rect: DOMRect | null): CSSProperties {
  if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  const clampedLeft = Math.min(Math.max(12, rect.left), window.innerWidth - CARD_W - 12);
  const fitsBelow = rect.bottom + 220 < window.innerHeight;
  return fitsBelow
    ? { top: rect.bottom + PAD + 12, left: clampedLeft }
    : { top: rect.top - PAD - 12, left: clampedLeft, transform: 'translateY(-100%)' };
}
