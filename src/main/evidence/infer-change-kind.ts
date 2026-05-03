import type { ChangeKind } from './rules';
import type { AgentName } from '../../shared/types';

const UI_FILE_RE = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|less)$/i;
const TEST_FILE_RE = /(\.|\/)(test|spec)\.[a-z]+$|\/__tests__\//i;
const BACKEND_FILE_RE = /\.(ts|js|py|rb|go|java|kt|rs|cs|php)$/i;

export interface InferInput {
  agentName: AgentName;
  filesChanged: string[];
}

export interface InferOutput {
  kind: ChangeKind;
  uiTouched: boolean;
  backendTouched: boolean;
  hasNonTestSourceChanges: boolean;
}

/**
 * Infer the ChangeKind from the agent that produced the patch + the touched
 * files. Test-only patches are uncommon for fixes, so we treat the agent's
 * intent as authoritative for the kind axis.
 */
export function inferChangeKind(input: InferInput): InferOutput {
  const uiTouched = input.filesChanged.some((f) => UI_FILE_RE.test(f) && !TEST_FILE_RE.test(f));
  const backendTouched = input.filesChanged.some(
    (f) => BACKEND_FILE_RE.test(f) && !TEST_FILE_RE.test(f) && !UI_FILE_RE.test(f),
  );
  const hasNonTestSourceChanges = input.filesChanged.some((f) => !TEST_FILE_RE.test(f));

  // Agent name drives the fundamental kind axis.
  let kind: ChangeKind;
  switch (input.agentName) {
    case 'bug-fixer':
      kind = 'bug_fix';
      break;
    case 'feature-builder':
      kind = 'new_feature';
      break;
    default:
      // QA Hunter / Manual QA / PR Reviewer don't open PRs in v0.1, but if
      // a future agent does, default to refactor (the strictest non-feature
      // bucket).
      kind = uiTouched && !hasNonTestSourceChanges ? 'ui_only' : 'refactor';
  }

  return { kind, uiTouched, backendTouched, hasNonTestSourceChanges };
}
