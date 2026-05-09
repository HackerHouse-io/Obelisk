import { describe, expect, it } from 'vitest';
import {
  detectStructuralDefects,
  parseXcuiSource,
  type XcuiElement,
} from '../../../../src/main/agents/ios-qa-pilot/visual-detect';

/* ---------- Tiny helpers for fixtures ---------- */

function attrs(o: Record<string, string | number | boolean>): string {
  return Object.entries(o)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
}

function el(
  type: string,
  bounds: { x: number; y: number; width: number; height: number },
  extra: Record<string, string | number | boolean> = {},
  inner = '',
): string {
  const attrStr = attrs({
    type,
    enabled: 'true',
    visible: 'true',
    ...bounds,
    ...extra,
  });
  return inner ? `<${type} ${attrStr}>${inner}</${type}>` : `<${type} ${attrStr}/>`;
}

function app(inner: string, w = 390, h = 844): string {
  return el('XCUIElementTypeApplication', { x: 0, y: 0, width: w, height: h }, {}, inner);
}

/* ---------- Parser ---------- */

describe('parseXcuiSource', () => {
  it('parses a flat self-closing element', () => {
    const xml = el(
      'XCUIElementTypeButton',
      { x: 0, y: 0, width: 44, height: 44 },
      {
        name: 'Login',
      },
    );
    const root = parseXcuiSource(xml)!;
    expect(root.type).toBe('XCUIElementTypeButton');
    expect(root.name).toBe('Login');
    expect(root.width).toBe(44);
  });

  it('parses nested children', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 10, width: 44, height: 44 }, { name: 'A' }) +
        el('XCUIElementTypeButton', { x: 60, y: 10, width: 44, height: 44 }, { name: 'B' }),
    );
    const root = parseXcuiSource(xml)!;
    expect(root.children.length).toBe(2);
    expect(root.children[0]!.name).toBe('A');
    expect(root.children[1]!.name).toBe('B');
  });

  it('strips XML declaration and comments', () => {
    const xml = `<?xml version="1.0"?><!-- ignore me -->${app(
      el('XCUIElementTypeStaticText', { x: 0, y: 0, width: 100, height: 20 }, { name: 'Hi' }),
    )}`;
    const root = parseXcuiSource(xml)!;
    expect(root.type).toBe('XCUIElementTypeApplication');
    expect(root.children[0]!.name).toBe('Hi');
  });

  it('returns null for empty / non-XML input', () => {
    expect(parseXcuiSource('')).toBeNull();
    expect(parseXcuiSource('not xml')).toBeNull();
  });

  it('decodes XML entities in attribute values', () => {
    const xml = el(
      'XCUIElementTypeStaticText',
      { x: 0, y: 0, width: 100, height: 20 },
      {
        name: 'A &amp; B',
      },
    );
    const root = parseXcuiSource(xml)!;
    expect(root.name).toBe('A & B');
  });
});

/* ---------- Rules ---------- */

describe('detectStructuralDefects — text cutoff', () => {
  it('flags text that extends past parent right edge', () => {
    const xml = app(
      el(
        'XCUIElementTypeStaticText',
        { x: 200, y: 50, width: 300, height: 20 }, // extends to x=500, parent ends at 390
        { name: 'Welcome to your first lesson' },
      ),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'text-cutoff')).toBeDefined();
    expect(defects.find((d) => d.rule === 'text-cutoff')!.symptom).toContain(
      "past parent's right edge",
    );
  });

  it('does not flag text that fits inside the parent', () => {
    const xml = app(
      el('XCUIElementTypeStaticText', { x: 10, y: 50, width: 100, height: 20 }, { name: 'OK' }),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'text-cutoff')).toBeUndefined();
  });
});

describe('detectStructuralDefects — tap target size', () => {
  it('flags an enabled button below 44×44pt', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 10, width: 30, height: 30 }, { name: 'X' }),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'tap-target-too-small')).toBeDefined();
  });

  it('does not flag a 44×44 button', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 10, width: 44, height: 44 }, { name: 'OK' }),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'tap-target-too-small')).toBeUndefined();
  });

  it('does not flag a small but disabled button', () => {
    const xml = app(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 30, height: 30 },
        { name: 'X', enabled: 'false' },
      ),
    );
    expect(detectStructuralDefects(xml)).toEqual([]);
  });
});

describe('detectStructuralDefects — truncation', () => {
  it('flags when name is a prefix of label and ends mid-word', () => {
    const xml = app(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 200, height: 44 },
        {
          name: 'Continue with email and pa',
          label: 'Continue with email and password',
        },
      ),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'truncation')).toBeDefined();
  });

  it('does not flag when name == label (full string available)', () => {
    const xml = app(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 200, height: 44 },
        { name: 'Continue', label: 'Continue' },
      ),
    );
    expect(detectStructuralDefects(xml).find((d) => d.rule === 'truncation')).toBeUndefined();
  });

  it('does not flag when the prefix ends on punctuation (likely intentional)', () => {
    const xml = app(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 200, height: 44 },
        { name: 'Settings...', label: 'Settings... advanced' },
      ),
    );
    expect(detectStructuralDefects(xml).find((d) => d.rule === 'truncation')).toBeUndefined();
  });
});

describe('detectStructuralDefects — sibling overlap', () => {
  it('flags two visible siblings whose frames intersect', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 10, width: 100, height: 44 }, { name: 'A' }) +
        el('XCUIElementTypeButton', { x: 50, y: 30, width: 100, height: 44 }, { name: 'B' }),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'sibling-overlap')).toBeDefined();
  });

  it('does not flag when one sibling fully contains the other (decorative)', () => {
    const xml = app(
      el('XCUIElementTypeImage', { x: 0, y: 0, width: 200, height: 200 }, { name: 'bg' }) +
        el(
          'XCUIElementTypeStaticText',
          { x: 10, y: 10, width: 100, height: 20 },
          {
            name: 'caption',
          },
        ),
    );
    expect(detectStructuralDefects(xml).find((d) => d.rule === 'sibling-overlap')).toBeUndefined();
  });
});

describe('detectStructuralDefects — row misalignment', () => {
  it('flags two siblings on the same row whose tops differ by > 2pt', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 100, width: 60, height: 44 }, { name: 'A' }) +
        el('XCUIElementTypeButton', { x: 80, y: 110, width: 60, height: 44 }, { name: 'B' }),
    );
    const defects = detectStructuralDefects(xml);
    expect(defects.find((d) => d.rule === 'row-misalignment')).toBeDefined();
  });

  it('does not flag siblings within tolerance', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 100, width: 60, height: 44 }, { name: 'A' }) +
        el('XCUIElementTypeButton', { x: 80, y: 101, width: 60, height: 44 }, { name: 'B' }),
    );
    expect(detectStructuralDefects(xml).find((d) => d.rule === 'row-misalignment')).toBeUndefined();
  });

  it('does not flag siblings on different rows', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 100, width: 60, height: 44 }, { name: 'top' }) +
        el('XCUIElementTypeButton', { x: 10, y: 200, width: 60, height: 44 }, { name: 'bottom' }),
    );
    expect(detectStructuralDefects(xml).find((d) => d.rule === 'row-misalignment')).toBeUndefined();
  });
});

describe('detectStructuralDefects — dedupe', () => {
  it('produces one finding per unique defect signature', () => {
    const xml = app(
      el('XCUIElementTypeButton', { x: 10, y: 10, width: 30, height: 30 }, { name: 'X' }),
    );
    // Run twice, ensure no duplicate appears in a single output.
    const defects = detectStructuralDefects(xml);
    const signatures = defects.map((d) => d.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('detectStructuralDefects — invisible elements ignored', () => {
  it('skips elements marked visible="false"', () => {
    const root: XcuiElement = parseXcuiSource(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 30, height: 30 },
        { name: 'X', visible: 'false' },
      ),
    )!;
    expect(root.visible).toBe(false);
    const defects = detectStructuralDefects(
      el(
        'XCUIElementTypeButton',
        { x: 10, y: 10, width: 30, height: 30 },
        { name: 'X', visible: 'false' },
      ),
    );
    expect(defects).toEqual([]);
  });
});
