import { listArtifacts, type EvidenceArtifact } from '../db/evidence';
import type { ChangeKind, EvidenceItem } from './rules';
import { requiredItemsFor } from './rules';
import type { InferOutput } from './infer-change-kind';

export interface CheckInput {
  runId: string;
  changeKind: ChangeKind;
  inferred: InferOutput;
}

export interface CheckResult {
  ok: boolean;
  missing: EvidenceItem[];
  presentByItem: Record<EvidenceItem, EvidenceArtifact[]>;
}

/**
 * Publish-time gate (TECH_DESIGN.md §9.2).
 * Reads the run's evidence_artifacts and checks that every required item
 * is present (and non-empty). Returns missing list + the resolved artifacts
 * grouped by item so the PR-body renderer can quote them.
 */
export function checkEvidence(input: CheckInput): CheckResult {
  const artifacts = listArtifacts(input.runId).filter((a) => a.bytes > 0);
  const required = requiredItemsFor(input.changeKind);
  const presentByItem = {} as Record<EvidenceItem, EvidenceArtifact[]>;
  const missing: EvidenceItem[] = [];

  for (const item of required) {
    const matches = artifacts.filter((a) => satisfies(item, a));
    if (item === 'ui_screenshot_if_ui_touched' && !input.inferred.uiTouched) {
      // Conditional item — skipped because UI wasn't touched.
      presentByItem[item] = [];
      continue;
    }
    if (item === 'before_after_screenshot_if_ui_touched' && !input.inferred.uiTouched) {
      presentByItem[item] = [];
      continue;
    }
    if (item === 'backend_log_or_curl_if_backend_touched' && !input.inferred.backendTouched) {
      presentByItem[item] = [];
      continue;
    }
    if (item === 'before_after_screenshot_if_ui_touched' && matches.length < 2) {
      missing.push(item);
      presentByItem[item] = matches;
      continue;
    }
    if (matches.length === 0) {
      missing.push(item);
      presentByItem[item] = [];
      continue;
    }
    presentByItem[item] = matches;
  }

  return { ok: missing.length === 0, missing, presentByItem };
}

function satisfies(item: EvidenceItem, a: EvidenceArtifact): boolean {
  switch (item) {
    case 'failing_test_diff':
      return a.kind === 'failing_test_diff' || a.kind === 'patch';
    case 'test_output':
      return a.kind === 'test_output';
    case 'new_tests':
      return a.kind === 'patch' || a.kind === 'failing_test_diff';
    case 'ui_screenshot':
    case 'ui_screenshot_if_ui_touched':
    case 'before_after_screenshot_if_ui_touched':
      return a.kind === 'screenshot';
    case 'backend_log_or_curl_if_backend_touched':
      return a.kind === 'log' || a.kind === 'curl_log';
  }
}
