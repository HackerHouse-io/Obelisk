import type { PreviewFollowup, QaFinding } from '../../../shared/types';

/**
 * Markers wrapping the JSON object the model emits after its short reply.
 * Mirrors QA-Hunter's BEGIN_FINDINGS / END_FINDINGS convention but uses a
 * singular tag because this turn produces exactly one updated finding.
 */
export const BEGIN_FINDING = 'BEGIN_FINDING';
export const END_FINDING = 'END_FINDING';

/**
 * Build the stdin prompt for one refine turn. The prompt is fully self-
 * contained — `claude -p` and `codex exec` are one-shot CLIs with no
 * server-side memory, so the conversation history travels with each turn.
 */
export function buildRefinePrompt(opts: {
  current: QaFinding;
  transcript: PreviewFollowup[];
  userMessage: string;
}): string {
  const transcriptBlock = opts.transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${m.content.trim()}`)
    .join('\n');

  return [
    'You are refining a GitHub bug-report draft. The user is iterating on',
    'the wording, scope, or classification of a finding before filing it.',
    '',
    'Output format — EXACTLY two parts, in this order:',
    '',
    '1) A 1–2 sentence reply to the user, plain text, explaining what you',
    '   changed and why. Address the user directly ("I").',
    `2) The full updated finding as a single JSON object between literal`,
    `   ${BEGIN_FINDING} / ${END_FINDING} markers on their own lines.`,
    '',
    'JSON schema (all keys required unless marked optional):',
    '{',
    '  "title": string,             // no [bug]/[smell] prefix — added downstream',
    '  "severity": "P0" | "P1" | "P2",',
    '  "description": string,',
    '  "expected": string,',
    '  "actual": string,',
    '  "repro": string,',
    '  "evidence": string (optional),',
    '  "suspected_files": string[],',
    '  "suggested_test": string,',
    '  "labels": string[]',
    '}',
    '',
    'Rules:',
    '- Preserve fields the user did not ask to change. Do not invent new',
    '  evidence or repro steps.',
    '- If the user says the spec/copy is wrong (not the code), reframe as a',
    '  spec/docs fix: update title, description, expected, actual, and',
    '  suspected_files. Adjust labels accordingly (e.g. add "spec" or',
    '  "docs"). Keep `obelisk:fix` if it was present.',
    '- Keep severity unless the user explicitly re-scopes it.',
    '- Output the JSON unconditionally even if no fields changed.',
    '- Reply text must NOT include the JSON or the markers; put the JSON',
    `  exclusively between ${BEGIN_FINDING} and ${END_FINDING}.`,
    '',
    '## Current finding (source of truth)',
    JSON.stringify(opts.current, null, 2),
    '',
    '## Conversation so far',
    transcriptBlock.length > 0 ? transcriptBlock : '(no prior turns)',
    '',
    '## New user message',
    opts.userMessage.trim(),
  ].join('\n');
}

/**
 * Extract the human-readable assistant reply (everything before the first
 * `BEGIN_FINDING` marker). Trims whitespace and trailing punctuation noise;
 * returns empty string if the marker is absent so callers can downgrade.
 */
export function extractAssistantReply(stdout: string): string {
  const idx = stdout.indexOf(BEGIN_FINDING);
  const head = idx >= 0 ? stdout.slice(0, idx) : stdout;
  return head.trim();
}
