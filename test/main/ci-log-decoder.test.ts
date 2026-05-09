import { describe, expect, it } from 'vitest';
import { decodeJobLog, parseJobIdFromDetailsUrl } from '../../src/main/scheduler/auto-merge';

describe('parseJobIdFromDetailsUrl', () => {
  it('extracts job_id from the canonical /actions/runs/<run>/job/<job> form', () => {
    expect(
      parseJobIdFromDetailsUrl('https://github.com/owner/repo/actions/runs/12345/job/67890'),
    ).toBe(67890);
  });

  it('also accepts /jobs/ pluralised', () => {
    expect(
      parseJobIdFromDetailsUrl('https://github.com/owner/repo/actions/runs/12345/jobs/67890'),
    ).toBe(67890);
  });

  it('strips trailing query / fragment / path segments', () => {
    expect(
      parseJobIdFromDetailsUrl('https://github.com/owner/repo/actions/runs/1/job/2?step=5'),
    ).toBe(2);
    expect(
      parseJobIdFromDetailsUrl('https://github.com/owner/repo/actions/runs/1/job/2#step:5:42'),
    ).toBe(2);
  });

  it('returns null for null, missing, or non-Actions URLs', () => {
    expect(parseJobIdFromDetailsUrl(null)).toBeNull();
    expect(parseJobIdFromDetailsUrl('')).toBeNull();
    expect(parseJobIdFromDetailsUrl('https://circleci.com/build/12')).toBeNull();
    expect(parseJobIdFromDetailsUrl('https://github.com/owner/repo/issues/42')).toBeNull();
  });

  it('rejects non-numeric job ids', () => {
    expect(
      parseJobIdFromDetailsUrl('https://github.com/owner/repo/actions/runs/1/job/notanumber'),
    ).toBeNull();
  });
});

describe('decodeJobLog', () => {
  it('passes string through unchanged', () => {
    expect(decodeJobLog('plain log line\nsecond line\n')).toBe('plain log line\nsecond line\n');
  });

  it('decodes a Node Buffer as utf-8', () => {
    expect(decodeJobLog(Buffer.from('utf8 buffer\n'))).toBe('utf8 buffer\n');
  });

  it('decodes an ArrayBuffer as utf-8', () => {
    const text = 'array buffer\n';
    const ab = new ArrayBuffer(text.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
    expect(decodeJobLog(ab)).toBe(text);
  });

  it('returns empty string for nullish / unsupported values', () => {
    expect(decodeJobLog(null)).toBe('');
    expect(decodeJobLog(undefined)).toBe('');
    expect(decodeJobLog(42)).toBe('');
  });
});
