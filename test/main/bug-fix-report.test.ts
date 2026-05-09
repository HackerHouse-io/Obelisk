import { describe, expect, it } from 'vitest';
import { parseBugFixReport } from '../../src/main/agents/bug-fixer';
import { renderPrBody } from '../../src/main/evidence/pr-body';

const EVIDENCE_OK = {
  ok: true,
  missing: [],
  presentByItem: {} as Record<string, never>,
};

const FULL_REPORT_JSON = `BEGIN_BUG_FIX_REPORT
{
  "summary": "Tapping a capstone node on the Home winding path opened the read-only StoryPlayer instead of the interactive CapstoneWorkshop. CourseDetailView.openUnit already routed these correctly via AppState.isInteractiveCapstone(_:), so Home and School disagreed on the same unit.",
  "root_cause": "In HomeView.route, capstone units matched the unit.conceptStoryId branch and returned early with .story(id:). The .capstone(courseId:) branch only fired when unit.kind == .assessment, but the authored curriculum has no .assessment units, so the workshop was unreachable from Home.",
  "fix": [
    "Extracted the dispatch into a pure helper HomeRouter.target(for:courseId:state:) so it can be unit-tested without SwiftUI.",
    "Added the AppState.isInteractiveCapstone(_:) whitelist check on the concept branch — same logic CourseDetailView uses.",
    "HomeView.route is now a one-line delegate."
  ],
  "test_plan": {
    "new_tests_file": "WealthLabTests/HomeRouterTests.swift",
    "cases": [
      { "name": "capstoneConcept_foundations_routesToWorkshop", "asserts": "Foundations BMC (fob-01-08) opens .capstone." },
      { "name": "capstoneConcept_allFoundersMBAPrograms_routeToWorkshop", "asserts": "every interactive capstone listed in AppState.isInteractiveCapstone(_:) opens .capstone." },
      { "name": "nonCapstoneConcept_routesToStoryPlayer", "asserts": "regular concept stories still open .story." },
      { "name": "lessonUnit_routesToLessonPlayerFromHome", "asserts": "lesson units still open .lesson with fromPath: nil so completion returns Home." },
      { "name": "lockedNode_doesNotRoute", "asserts": "locked nodes navigate nowhere." }
    ],
    "manual_verification": "Manual verification on iPhone 17 / iOS 26.2: tapping the BMC node from Home opens the Capstone Workshop; the StoryPlayer is no longer reachable for whitelisted capstones."
  },
  "notes": [
    "Merged main into the branch and resolved one conflict in HomeView.swift. Main had moved case-study routing from .story(id:) to .unitDetail(courseId:, unitId:); HomeRouter was updated to match so behavior stays identical.",
    "Removed .claude/ agent-runtime files that were committed by accident — they don't belong in the production repo."
  ]
}
END_BUG_FIX_REPORT`;

describe('parseBugFixReport', () => {
  it('extracts the new structured shape (summary, root_cause, fix bullets, test_plan, notes)', () => {
    const out = parseBugFixReport(FULL_REPORT_JSON);
    expect(out).not.toBeNull();
    expect(out!.summary).toMatch(/Tapping a capstone node/);
    expect(out!.root_cause).toMatch(/HomeView\.route/);
    expect(out!.fix).toHaveLength(3);
    expect(out!.fix[0]).toMatch(/HomeRouter/);
    expect(out!.test_plan?.new_tests_file).toBe('WealthLabTests/HomeRouterTests.swift');
    expect(out!.test_plan?.cases).toHaveLength(5);
    expect(out!.test_plan?.cases![0]).toEqual({
      name: 'capstoneConcept_foundations_routesToWorkshop',
      asserts: 'Foundations BMC (fob-01-08) opens .capstone.',
    });
    expect(out!.test_plan?.manual_verification).toMatch(/iPhone 17/);
    expect(out!.notes).toHaveLength(2);
  });

  it('accepts a minimal report (just summary + root_cause + fix bullets)', () => {
    const json = `BEGIN_BUG_FIX_REPORT
{
  "summary": "x",
  "root_cause": "y",
  "fix": ["z"]
}
END_BUG_FIX_REPORT`;
    const out = parseBugFixReport(json);
    expect(out).toEqual({ summary: 'x', root_cause: 'y', fix: ['z'] });
  });

  it('drops empty notes / cases so the renderer can skip those sections cleanly', () => {
    const json = `BEGIN_BUG_FIX_REPORT
{
  "summary": "x", "root_cause": "y", "fix": ["z"],
  "notes": ["", "   "],
  "test_plan": { "cases": [{ "name": "", "asserts": "x" }] }
}
END_BUG_FIX_REPORT`;
    const out = parseBugFixReport(json);
    expect(out?.notes).toBeUndefined();
    expect(out?.test_plan?.cases).toBeUndefined();
  });

  it('returns null when fix is missing or empty', () => {
    expect(
      parseBugFixReport(`BEGIN_BUG_FIX_REPORT
{ "summary": "x", "root_cause": "y" }
END_BUG_FIX_REPORT`),
    ).toBeNull();
    expect(
      parseBugFixReport(`BEGIN_BUG_FIX_REPORT
{ "summary": "x", "root_cause": "y", "fix": [] }
END_BUG_FIX_REPORT`),
    ).toBeNull();
  });

  it('returns null when the block is missing entirely', () => {
    expect(parseBugFixReport('just narration, no block here')).toBeNull();
    expect(parseBugFixReport('')).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    const bad = `BEGIN_BUG_FIX_REPORT
{ "summary": "no comma" "root_cause": "x" }
END_BUG_FIX_REPORT`;
    expect(parseBugFixReport(bad)).toBeNull();
  });
});

describe('renderPrBody (senior-engineer template for bug-fixer PRs)', () => {
  it('matches the user-approved shape exactly: Fixes #N. → Summary → Root cause → Fix → Test plan → Notes → footer', () => {
    const report = parseBugFixReport(FULL_REPORT_JSON)!;
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId: '01HX',
      taskRef: 'issue#4',
      summary: 'unused-on-this-path',
      reasoning: 'unused-on-this-path',
      evidence: EVIDENCE_OK,
      bugFixReport: report,
    });

    // 1. Lead line auto-closes the issue.
    expect(body).toMatch(/^Fixes #4\.\n/);

    // 2. Section ordering — Summary first, then Root cause, Fix, Test plan, Notes.
    const idx = (heading: string): number => body.indexOf(heading);
    expect(idx('## Summary')).toBeGreaterThan(0);
    expect(idx('## Root cause')).toBeGreaterThan(idx('## Summary'));
    expect(idx('## Fix')).toBeGreaterThan(idx('## Root cause'));
    expect(idx('## Test plan')).toBeGreaterThan(idx('## Fix'));
    expect(idx('## Notes')).toBeGreaterThan(idx('## Test plan'));

    // 3. Fix bullets render as a markdown list.
    expect(body).toContain(
      '- Extracted the dispatch into a pure helper HomeRouter.target(for:courseId:state:)',
    );
    expect(body).toContain('- HomeView.route is now a one-line delegate.');

    // 4. Test plan opens with the new-tests-file pointer.
    expect(body).toContain('New `WealthLabTests/HomeRouterTests.swift` covers:');
    expect(body).toContain(
      '- `capstoneConcept_foundations_routesToWorkshop` — Foundations BMC (fob-01-08) opens .capstone.',
    );
    expect(body).toContain('Manual verification: Manual verification on iPhone 17 / iOS 26.2');

    // 5. Notes bullets.
    expect(body).toContain('- Merged main into the branch');
    expect(body).toContain("- Removed .claude/ agent-runtime files");

    // 6. Footer is below a horizontal rule and contains the disclosure.
    expect(body).toMatch(/\n---\n/);
    expect(body).toMatch(/_Authored by Obelisk Bug Fixer_/);
    expect(body).toMatch(/\/obelisk explain/);

    // 7. None of the noise from earlier iterations leaks through:
    //    - no top-level "## Reasoning" dump
    //    - no "## Evidence" with obelisk:// artifact URIs
    //    - no top-level disclosure block at the head
    expect(body).not.toMatch(/^## Reasoning/m);
    expect(body).not.toMatch(/^## Evidence$/m);
    expect(body).not.toContain('obelisk://artifact');
    expect(body).not.toMatch(/^> Authored by Obelisk/m);
  });

  it('omits the Test plan section when no cases / manual verification are provided', () => {
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId: '01HX',
      taskRef: 'issue#7',
      summary: '',
      reasoning: '',
      evidence: EVIDENCE_OK,
      bugFixReport: { summary: 's', root_cause: 'r', fix: ['change x'] },
    });
    expect(body).not.toContain('## Test plan');
    expect(body).toContain('Fixes #7.');
  });

  it('omits the Notes section when notes is empty', () => {
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId: '01HX',
      taskRef: 'issue#7',
      summary: '',
      reasoning: '',
      evidence: EVIDENCE_OK,
      bugFixReport: { summary: 's', root_cause: 'r', fix: ['change x'] },
    });
    expect(body).not.toContain('## Notes');
  });

  it('omits the `Fixes #N.` lead when the task ref is not a github issue (manual backlog)', () => {
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId: '01HX',
      taskRef: 'backlog#01HXYZ',
      summary: '',
      reasoning: '',
      evidence: EVIDENCE_OK,
      bugFixReport: { summary: 's', root_cause: 'r', fix: ['change x'] },
    });
    expect(body).not.toMatch(/^Fixes #/);
    // First section is Summary, not the Fixes line.
    expect(body.split('\n', 1)[0]).toBe('## Summary');
  });

  it('falls back to legacy Summary + Reasoning shape when no report is provided', () => {
    const body = renderPrBody({
      agentName: 'bug-fixer',
      runId: '01HX',
      taskRef: 'issue#42',
      summary: 'one-liner',
      reasoning: 'detailed reasoning trace',
      evidence: EVIDENCE_OK,
    });
    expect(body).toContain('## Summary\n\none-liner');
    expect(body).toContain('## Reasoning\n\ndetailed reasoning trace');
  });
});
