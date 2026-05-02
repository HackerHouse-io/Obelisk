import { describe, it, expect } from 'vitest';
import { canonicalStringify } from '../../src/main/prompt-compiler/canonical-json';

describe('canonicalStringify', () => {
  it('orders object keys alphabetically', () => {
    const a = canonicalStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested objects + arrays', () => {
    const out = canonicalStringify({
      outer: { z: [1, 2, 3], a: { y: 'y', x: 'x' } },
    });
    expect(out).toBe('{"outer":{"a":{"x":"x","y":"y"},"z":[1,2,3]}}');
  });

  it('treats null + undefined consistently with JSON.stringify', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify({ a: undefined })).toBe('{}');
  });
});
