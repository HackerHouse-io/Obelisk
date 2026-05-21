import { describe, it, expect } from 'vitest';
import {
  parseFencedJson,
  parseFencedJsonObject,
} from '../../src/main/agents/lib/parse-fenced-json';
import { bodyFor, isFinding, parseBodyToFinding } from '../../src/main/agents/qa-hunter';
import {
  BEGIN_FINDING,
  END_FINDING,
  buildRefinePrompt,
  extractAssistantReply,
} from '../../src/main/agents/preview-followup/prompt';
import type { QaFinding, PreviewFollowup } from '../../src/shared/types';

const SAMPLE_FINDING: QaFinding = {
  title: 'Profile Achievements tile label reads "Time learning" but pinned spec expects "Time spent"',
  severity: 'P2',
  description: 'The Profile achievements grid surfaces t.profileTime for the time-spent tile, which is "Time learning" in I18N.swift.',
  expected: 'The Profile achievements row renders a tile labelled "Time spent".',
  actual: 'The tile renders as "Time learning".',
  repro: '1. cd repo; xcodebuild test. 2. Observe 4 failed tests.',
  suspected_files: ['WealthLab/I18N.swift'],
  suggested_test: 'Add a test that asserts tile labels match the spec.',
  labels: ['obelisk:fix', 'P2'],
};

describe('parseFencedJsonObject', () => {
  it('returns the parsed object when the type guard passes', () => {
    const stdout = `Some reply text.\n\n${BEGIN_FINDING}\n${JSON.stringify(SAMPLE_FINDING)}\n${END_FINDING}`;
    const parsed = parseFencedJsonObject<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toContain('Profile Achievements');
    expect(parsed!.severity).toBe('P2');
  });

  it('returns null when the begin marker is missing', () => {
    const stdout = `Just plain text — no JSON here.`;
    expect(
      parseFencedJsonObject<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding),
    ).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const stdout = `${BEGIN_FINDING}\n{ not valid json\n${END_FINDING}`;
    expect(
      parseFencedJsonObject<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding),
    ).toBeNull();
  });

  it('returns null when the type guard rejects', () => {
    const bogus = { title: 'no severity' };
    const stdout = `${BEGIN_FINDING}\n${JSON.stringify(bogus)}\n${END_FINDING}`;
    expect(
      parseFencedJsonObject<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding),
    ).toBeNull();
  });

  it('rejects arrays — that path belongs to parseFencedJson', () => {
    const stdout = `${BEGIN_FINDING}\n${JSON.stringify([SAMPLE_FINDING])}\n${END_FINDING}`;
    expect(
      parseFencedJsonObject<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding),
    ).toBeNull();
    // Sanity: the array form still works through the array parser.
    expect(parseFencedJson<QaFinding>(stdout, BEGIN_FINDING, END_FINDING, isFinding)).toHaveLength(
      1,
    );
  });
});

describe('extractAssistantReply', () => {
  it('returns the text before the BEGIN_FINDING marker, trimmed', () => {
    const stdout = `I reframed this as a spec fix.\n\n${BEGIN_FINDING}\n{}\n${END_FINDING}`;
    expect(extractAssistantReply(stdout)).toBe('I reframed this as a spec fix.');
  });

  it('returns the full output when no marker is present', () => {
    expect(extractAssistantReply('  just prose  ')).toBe('just prose');
  });
});

describe('parseBodyToFinding', () => {
  it('round-trips a bodyFor-rendered finding back to a valid Finding', () => {
    const rendered = bodyFor(SAMPLE_FINDING);
    const parsed = parseBodyToFinding({
      title: '[smell] ' + SAMPLE_FINDING.title,
      body: rendered,
      labels: ['obelisk:fix', 'P2'],
    });
    expect(isFinding(parsed)).toBe(true);
    expect(parsed.title).toBe(SAMPLE_FINDING.title);
    expect(parsed.severity).toBe('P2');
    expect(parsed.expected).toBe(SAMPLE_FINDING.expected);
    expect(parsed.actual).toBe(SAMPLE_FINDING.actual);
    expect(parsed.suspected_files).toEqual(SAMPLE_FINDING.suspected_files);
  });

  it('falls back to placeholders for missing sections', () => {
    const parsed = parseBodyToFinding({
      title: 'Random freeform title',
      body: 'A draft with no section headers.',
      labels: ['obelisk:fix'],
    });
    expect(isFinding(parsed)).toBe(true);
    expect(parsed.severity).toBe('P2'); // default when labels lack a severity
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.expected.length).toBeGreaterThan(0);
    expect(parsed.actual.length).toBeGreaterThan(0);
    expect(parsed.suspected_files).toEqual([]);
  });

  it('recognizes both bare and severity:Px labels', () => {
    const a = parseBodyToFinding({ title: 't', body: '', labels: ['P0'] });
    expect(a.severity).toBe('P0');
    const b = parseBodyToFinding({ title: 't', body: '', labels: ['severity:P1'] });
    expect(b.severity).toBe('P1');
  });
});

describe('buildRefinePrompt', () => {
  it('includes the current finding JSON and the new user message', () => {
    const transcript: PreviewFollowup[] = [];
    const prompt = buildRefinePrompt({
      current: SAMPLE_FINDING,
      transcript,
      userMessage: 'Actually the label "Time learning" is correct — update the spec instead.',
    });
    expect(prompt).toContain(BEGIN_FINDING);
    expect(prompt).toContain('## Current finding');
    expect(prompt).toContain('Time learning');
    expect(prompt).toContain(
      'Actually the label "Time learning" is correct — update the spec instead.',
    );
    expect(prompt).toMatch(/## Conversation so far[\s\S]*\(no prior turns\)/);
  });

  it('renders prior transcript turns and drops the internal system snapshot', () => {
    const at = '2026-05-21T00:00:00Z';
    const transcript: PreviewFollowup[] = [
      { id: 1, previewId: 42, role: 'system', content: '{...original payload...}', createdAt: at },
      { id: 2, previewId: 42, role: 'user', content: 'flip it to spec', createdAt: at },
      { id: 3, previewId: 42, role: 'assistant', content: 'Got it.', createdAt: at },
    ];
    const prompt = buildRefinePrompt({
      current: SAMPLE_FINDING,
      transcript,
      userMessage: 'and bump severity to P1',
    });
    expect(prompt).toContain('user: flip it to spec');
    expect(prompt).toContain('assistant: Got it.');
    expect(prompt).not.toContain('original payload'); // system row excluded
  });
});
