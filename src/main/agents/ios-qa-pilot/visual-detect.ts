/**
 * Deterministic structural defect detector for XCUITest hierarchies.
 *
 * The iOS QA Pilot agent dumps `driver.source` (XCUI XML) for every
 * screen it visits. The orchestrator runs THIS file's rules over each
 * dump — pure arithmetic on element bounds, no LLM tokens — and
 * emits findings for every detected defect.
 *
 * Why local detection: LLMs miss bound-arithmetic defects (text
 * cutoff, overlap, tap target size) at high rates and burn tokens
 * scrutinizing layouts they could just compute. By moving the
 * mechanical rules into TypeScript we (a) catch everything reliably,
 * (b) free the agent to spend its budget on subjective visuals
 * (color, kerning, broken images, dark mode) the rules can't touch.
 */

export interface XcuiElement {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  enabled: boolean;
  visible: boolean;
  /** All bounds are in points, screen-space. */
  x: number;
  y: number;
  width: number;
  height: number;
  children: XcuiElement[];
}

export type DefectRule =
  | 'text-cutoff'
  | 'tap-target-too-small'
  | 'truncation'
  | 'sibling-overlap'
  | 'row-misalignment';

export interface StructuralDefect {
  rule: DefectRule;
  /** Stable id for de-duping ("rule|elementType|elementName|x,y,w,h"). */
  signature: string;
  symptom: string;
  severity: 'P1' | 'P2';
  element: {
    type: string;
    name?: string;
    label?: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
}

const TAPPABLE_TYPES = new Set([
  'XCUIElementTypeButton',
  'XCUIElementTypeCell',
  'XCUIElementTypeImage',
  'XCUIElementTypeLink',
]);

const TEXT_TYPES = new Set([
  'XCUIElementTypeStaticText',
  'XCUIElementTypeTextView',
  'XCUIElementTypeTextField',
  'XCUIElementTypeButton',
]);

// Tap-target floor from Apple HIG. 44 × 44 points.
const TAP_TARGET_MIN = 44;
// Misalignment tolerance — anything above this between siblings on the
// same row is flagged.
const ALIGN_TOLERANCE_PT = 2;

/* ---------- Public API ---------- */

export function detectStructuralDefects(xcuiSource: string): StructuralDefect[] {
  const root = parseXcuiSource(xcuiSource);
  if (!root) return [];
  const defects: StructuralDefect[] = [];
  walk(root, null, (el, parent) => {
    if (!el.visible) return;
    if (parent) checkTextCutoff(el, parent, defects);
    checkTapTarget(el, defects);
    checkTruncation(el, defects);
    if (parent) checkSiblingOverlapAndAlignment(el, parent, defects);
  });
  return dedupe(defects);
}

/* ---------- Rules ---------- */

function checkTextCutoff(el: XcuiElement, parent: XcuiElement, out: StructuralDefect[]): void {
  if (!TEXT_TYPES.has(el.type)) return;
  const overflowsRight = el.x + el.width > parent.x + parent.width + 0.5;
  const overflowsBottom = el.y + el.height > parent.y + parent.height + 0.5;
  if (!overflowsRight && !overflowsBottom) return;
  const direction =
    overflowsRight && overflowsBottom
      ? 'past parent bounds'
      : overflowsRight
        ? "past parent's right edge"
        : "past parent's bottom edge";
  const sevHint = el.type === 'XCUIElementTypeButton' ? 'P1' : 'P2';
  const labelDesc = describeText(el);
  out.push({
    rule: 'text-cutoff',
    signature: signatureFor('text-cutoff', el),
    symptom: `${humanType(el.type)}${labelDesc} extends ${direction}.`,
    severity: sevHint,
    element: extractRef(el),
  });
}

function checkTapTarget(el: XcuiElement, out: StructuralDefect[]): void {
  if (!TAPPABLE_TYPES.has(el.type)) return;
  if (!el.enabled) return;
  if (el.width >= TAP_TARGET_MIN && el.height >= TAP_TARGET_MIN) return;
  out.push({
    rule: 'tap-target-too-small',
    signature: signatureFor('tap-target-too-small', el),
    symptom: `${humanType(el.type)}${describeText(el)} is ${el.width}×${el.height}pt — below Apple's 44×44 minimum tap target.`,
    severity: el.type === 'XCUIElementTypeButton' ? 'P1' : 'P2',
    element: extractRef(el),
  });
}

function checkTruncation(el: XcuiElement, out: StructuralDefect[]): void {
  // Heuristic: when accessibility `name` is a strict prefix of `label`
  // and ends mid-word, the rendered string was truncated. Apps that
  // use full label as accessibility name skip this rule entirely.
  if (!el.name || !el.label) return;
  if (el.name === el.label) return;
  if (!el.label.startsWith(el.name)) return;
  // Trim trailing whitespace before checking the boundary character.
  const tail = el.name.replace(/\s+$/, '');
  if (tail.length === 0) return;
  const last = tail.charCodeAt(tail.length - 1);
  // Letters/digits → almost certainly truncated mid-word. Punctuation
  // is suspicious but not necessarily a bug.
  const isAlnum =
    (last >= 48 && last <= 57) || (last >= 65 && last <= 90) || (last >= 97 && last <= 122);
  if (!isAlnum) return;
  out.push({
    rule: 'truncation',
    signature: signatureFor('truncation', el),
    symptom: `${humanType(el.type)} shows "${el.name}" but its accessibility label is "${el.label}" — the visible text appears truncated mid-word.`,
    severity: 'P1',
    element: extractRef(el),
  });
}

function checkSiblingOverlapAndAlignment(
  el: XcuiElement,
  parent: XcuiElement,
  out: StructuralDefect[],
): void {
  // Both rules look across siblings of `parent`. We process each
  // (parent, el) pair once by gating on being the first visible
  // sibling — sufficient because dedupe collapses pairs anyway.
  const siblings = parent.children.filter((c) => c.visible);
  if (siblings[0] !== el) return;

  for (let i = 0; i < siblings.length; i++) {
    const a = siblings[i]!;
    for (let j = i + 1; j < siblings.length; j++) {
      const b = siblings[j]!;
      if (rectsOverlap(a, b)) {
        // Skip when one contains the other — that's just a child-in-
        // parent relationship reported again at sibling level.
        if (rectContains(a, b) || rectContains(b, a)) continue;
        out.push({
          rule: 'sibling-overlap',
          signature: signatureFor('sibling-overlap', a, b),
          symptom: `${humanType(a.type)}${describeText(a)} overlaps ${humanType(b.type)}${describeText(b)} (${rectAreaIntersect(a, b)}pt² intersection).`,
          severity: 'P1',
          element: extractRef(a),
        });
      }
      if (sameRow(a, b) && Math.abs(a.y - b.y) > ALIGN_TOLERANCE_PT) {
        out.push({
          rule: 'row-misalignment',
          signature: signatureFor('row-misalignment', a, b),
          symptom: `${humanType(a.type)}${describeText(a)} (y=${a.y}) and ${humanType(b.type)}${describeText(b)} (y=${b.y}) sit on the same row but their tops differ by ${Math.abs(a.y - b.y)}pt.`,
          severity: 'P2',
          element: extractRef(a),
        });
      }
    }
  }
}

/* ---------- Helpers ---------- */

function rectsOverlap(a: XcuiElement, b: XcuiElement): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function rectContains(outer: XcuiElement, inner: XcuiElement): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function rectAreaIntersect(a: XcuiElement, b: XcuiElement): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return Math.round(x * y);
}

function sameRow(a: XcuiElement, b: XcuiElement): boolean {
  // Two siblings are "on the same row" when their vertical centers
  // are within roughly half their height of each other — much looser
  // than misalignment tolerance, which compares their top edges.
  const aMidY = a.y + a.height / 2;
  const bMidY = b.y + b.height / 2;
  const radius = Math.max(a.height, b.height) / 2;
  return Math.abs(aMidY - bMidY) <= radius;
}

function describeText(el: XcuiElement): string {
  const text = el.name || el.label || el.value;
  return text ? ` "${truncateForMessage(text)}"` : '';
}

function truncateForMessage(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function humanType(type: string): string {
  return type.replace(/^XCUIElementType/, '');
}

function extractRef(el: XcuiElement): StructuralDefect['element'] {
  const ref: StructuralDefect['element'] = {
    type: el.type,
    bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
  };
  if (el.name) ref.name = el.name;
  if (el.label) ref.label = el.label;
  return ref;
}

function signatureFor(rule: DefectRule, ...elements: XcuiElement[]): string {
  return [
    rule,
    ...elements.map((e) => `${e.type}|${e.name ?? ''}|${e.x},${e.y},${e.width},${e.height}`),
  ].join('::');
}

function dedupe(defects: StructuralDefect[]): StructuralDefect[] {
  const seen = new Set<string>();
  const out: StructuralDefect[] = [];
  for (const d of defects) {
    if (seen.has(d.signature)) continue;
    seen.add(d.signature);
    out.push(d);
  }
  return out;
}

function walk(
  el: XcuiElement,
  parent: XcuiElement | null,
  visit: (el: XcuiElement, parent: XcuiElement | null) => void,
): void {
  visit(el, parent);
  for (const c of el.children) walk(c, el, visit);
}

/* ---------- Tiny XCUI XML parser ---------- */

/**
 * XCUI source is regular: every element is `<XCUIElementType... attrs/>`
 * or `<XCUIElementType... attrs>...</XCUIElementType>`. Attributes are
 * always quoted. Children are nested elements. Text nodes don't
 * appear (it's a structural dump, not a content document).
 *
 * This is permissive: malformed input returns null so callers can
 * skip defect detection rather than crashing the run.
 */
export function parseXcuiSource(source: string): XcuiElement | null {
  if (!source) return null;
  // Drop XML declaration, processing instructions, comments.
  const cleaned = source
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!cleaned.startsWith('<')) return null;

  const tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)([^>]*?)(\/?)>/g;
  const stack: XcuiElement[] = [];
  let root: XcuiElement | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const isClose = m[0].startsWith('</');
    const name = m[1]!;
    const attrs = m[2]!;
    const selfClosing = m[3] === '/';

    if (isClose) {
      stack.pop();
      continue;
    }
    if (!name.startsWith('XCUIElementType')) continue;

    const el: XcuiElement = {
      type: name,
      enabled: parseBoolAttr(attrs, 'enabled', true),
      visible: parseBoolAttr(attrs, 'visible', true),
      x: parseIntAttr(attrs, 'x', 0),
      y: parseIntAttr(attrs, 'y', 0),
      width: parseIntAttr(attrs, 'width', 0),
      height: parseIntAttr(attrs, 'height', 0),
      children: [],
    };
    const nm = parseStringAttr(attrs, 'name');
    if (nm !== undefined) el.name = nm;
    const lbl = parseStringAttr(attrs, 'label');
    if (lbl !== undefined) el.label = lbl;
    const val = parseStringAttr(attrs, 'value');
    if (val !== undefined) el.value = val;

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;

    if (!selfClosing) stack.push(el);
  }

  return root;
}

function parseStringAttr(attrs: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeXmlEntities(m[1]!);
}

function parseIntAttr(attrs: string, key: string, fallback: number): number {
  const s = parseStringAttr(attrs, key);
  if (s === undefined) return fallback;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolAttr(attrs: string, key: string, fallback: boolean): boolean {
  const s = parseStringAttr(attrs, key);
  if (s === undefined) return fallback;
  return s === 'true' || s === '1' || s === 'YES';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
