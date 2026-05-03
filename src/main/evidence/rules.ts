/**
 * The Evidence Pack rule engine — TECH_DESIGN.md §9.1.
 * No PR ships without proof.
 */

export type ChangeKind = 'bug_fix' | 'new_feature' | 'refactor' | 'ui_only';

export type EvidenceItem =
  | 'failing_test_diff'
  | 'test_output'
  | 'new_tests'
  | 'ui_screenshot'
  | 'ui_screenshot_if_ui_touched'
  | 'before_after_screenshot_if_ui_touched'
  | 'backend_log_or_curl_if_backend_touched';

export const REQUIRED_BY_KIND: Record<ChangeKind, EvidenceItem[]> = {
  bug_fix: ['failing_test_diff', 'test_output', 'ui_screenshot_if_ui_touched'],
  new_feature: [
    'new_tests',
    'test_output',
    'ui_screenshot_if_ui_touched',
    'backend_log_or_curl_if_backend_touched',
  ],
  refactor: ['test_output', 'before_after_screenshot_if_ui_touched'],
  ui_only: ['ui_screenshot'],
};

export function requiredItemsFor(kind: ChangeKind): EvidenceItem[] {
  return REQUIRED_BY_KIND[kind];
}
