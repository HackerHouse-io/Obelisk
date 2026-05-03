# test-fixtures/

Per-fixture mini-repos consumed by L2-real and L3 test suites
(`docs/TEST_PLAN.md` §2). These are checked-in full repos, no submodules.

The current Phase-11 status: L2 tests construct fixture repos in `tmpdir()`
on the fly because the failure-mode coverage doesn't depend on a stable
checked-in tree. The fixtures below land as their dependent suites land.

| Fixture | Purpose | Lands in |
|---|---|---|
| `express-buggy/` | Bug Fixer happy path on a backend repo. Seeded bug: missing input validation on POST /reports throws 500. | L2-real golden tasks |
| `react-todo-buggy/` | Bug Fixer + Manual QA on a UI repo. Seeded bug: refresh after creating a todo loses the new item. | L2-real + L3 smoke |
| `express-feature-request/` | Feature Builder happy path. Seeded issue: "Add CSV export to /reports." | L2-real |
| `react-feature-request/` | Feature Builder happy path on a UI repo. Seeded issue: "Add a dark-mode toggle." | L2-real |
| `express-refactor/` | Refactor scenario for PR Reviewer + Evidence-Pack rules. | L2-real |
| `qa-playbook-bootstrap/` | QA Playbook bootstrapper input — sitemap, seed users, a few routes. | L2 |
| `non-bug-trap/` | Manual QA negative fixture: an upgrade modal that should be in `non-bugs.md`. Asserts no false-positive issue is filed. | L2 |

Each fixture (when checked in) ships:
- `FIXTURE.md` — description, seeded defects, expected agent outputs (titles, PR diff shape, Evidence Pack items).
- `expected-snapshots/` — frozen snapshots of the compiled prompts and Evidence Pack contents the happy-path test asserts against.
- `package.json` with `npm test` and `npm run e2e` wired to the fixture's own runners.

Tests copy a fresh fixture into a temp dir per test (no in-place mutation).
