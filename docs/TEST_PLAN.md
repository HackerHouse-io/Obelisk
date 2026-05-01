# Obelisk — Test Plan

**Status:** Draft for the initial release.
**Audience:** Contributors writing or running Obelisk tests.
**Companion docs:** [`PRD.md`](../PRD.md) · [`TECH_DESIGN.md`](./TECH_DESIGN.md) · [`AGENT_ARCHITECTURE.md`](./AGENT_ARCHITECTURE.md).

The goal of this plan is to keep three properties true on every commit:

1. **The local-first promise holds** — no test depends on Obelisk-operated infrastructure.
2. **The Evidence Pack rule is real** — no PR ever ships without proof, and the test suite can prove that for every change type in [`PRD.md` §7.2](../PRD.md#72-pr-evidence-pack-no-pr-ships-without-proof).
3. **Safety modes are physically enforced** — Observe-only cannot push, mode upgrades require re-auth, mode downgrades abort cleanly.

---

## 1. Test layers

| Layer | Scope | Tooling | Runs on |
|---|---|---|---|
| **L1 Unit** | Pure functions: prompt compiler, runner adapters, scheduler arithmetic, evidence-check rules, OAuth scope mapper, label parsers, SQLite migrations. | Vitest. | Every PR, every push. Sub-second per file. |
| **L2 Integration** | Agent runs end-to-end with a mocked CLI runner and a recorded GitHub API. Per-agent happy-path + three failure-mode cases. | Vitest + a `MockRunner` + `nock` for HTTP. | Every PR. <2 min total. |
| **L2-real** | A small, frozen "golden tasks" suite that invokes a *real* Claude Code or Codex CLI against fixture repos. Spends tokens. | Vitest (tagged `@real-cli`) + real CLIs. | Nightly + release-blocking. |
| **L3 End-to-end** | Playwright drives the packaged Electron binary against a recorded GitHub API and a `MockRunner`. Automates the PRD §11 verification plan. | Playwright (`@playwright/test`) launching the Electron build. | Nightly + release-blocking. |

Coverage targets (lines): L1 ≥ 90% for `src/main/**`, ≥ 80% overall. No target for L2/L3 — they assert behavior, not lines.

---

## 2. Fixture catalog

All fixtures live under `test-fixtures/` and are checked into git as full mini-repos (no submodules). Each has a deterministic seed and a `FIXTURE.md` describing the seeded bugs / features and the expected agent outputs.

| Fixture | Stack | Purpose |
|---|---|---|
| `express-buggy/` | Express + Vitest | Bug Fixer happy path on a backend repo. Seeded bug: missing-input validation in a POST handler that throws 500. |
| `react-todo-buggy/` | Vite + React + Vitest + Playwright | Bug Fixer + Manual QA on a UI repo. Seeded bug: refresh after creating a todo loses the new item (persistence bug). |
| `express-feature-request/` | Express + Vitest | Feature Builder happy path. Seeded issue: "Add CSV export to /reports." |
| `react-feature-request/` | Vite + React + Vitest + Playwright | Feature Builder happy path on a UI repo. Seeded issue: "Add a dark-mode toggle." |
| `express-refactor/` | Express + Vitest | Refactor scenario for PR Reviewer + Evidence-Pack rules. |
| `qa-playbook-bootstrap/` | Vite + React | QA Playbook bootstrapper input — has sitemap, seed users, a few routes. |
| `non-bug-trap/` | Vite + React | Manual QA *negative* fixture: an upgrade modal that should be in `non-bugs.md`. Asserts no issue is filed. |

Each fixture ships with:

- `FIXTURE.md` — description, seeded defects, expected agent outputs (titles, PR diff shape, Evidence Pack items).
- `expected-snapshots/` — frozen snapshots of the compiled prompts and the Evidence Pack contents that the happy-path integration test asserts against.
- A `package.json` with `npm test` and `npm run e2e` wired up to the fixture's own runners.

Test runner copies a fresh fixture into a temp dir per test (no in-place mutation).

---

## 3. GitHub API recording

CI must be hermetic — no real GitHub calls during PR runs. Strategy:

- **Recording**: a developer with a personal token runs `pnpm test:record <fixture-name>` against a real test repo. The HTTP cassette is saved under `test-fixtures/<fixture>/cassettes/` and committed.
- **Replay**: in CI and local runs, `nock` is configured at test setup to load cassettes for the fixture; any unmatched HTTP call fails the test.
- **Re-record cadence**: cassettes are re-recorded when a fixture's GitHub interactions change or when GitHub API contracts shift (e.g., a deprecated endpoint). A monthly job re-records the suite and opens a PR if anything diverged.

Cassettes never contain real tokens — recording redacts `Authorization` and any PAT-shaped strings.

---

## 4. CLI runner stubbing strategy

### 4.1 `MockRunner` (default in L1, L2, L3)

```ts
class MockRunner implements CodingAgentRunner {
  kind = 'claude' | 'codex'
  // Lookup table keyed by contentHash → canned RunResult
  // Built from test-fixtures/<fixture>/runner-fixtures/<hash>.json
}
```

Every L2 test names the fixture and a scenario; the runner returns a pre-recorded patch + test output + reasoning. This makes L2 cheap, deterministic, and offline.

### 4.2 Real-CLI suite (L2-real)

A frozen list of ~10 "golden tasks" — one per `(agent, fixture)` combination that we deeply care about. These run real `claude` or `codex` CLI invocations against the fixture and assert *envelope* properties only:

- The patch touches the expected files.
- The Evidence Pack is complete.
- The compiled prompt's `contentHash` matches the snapshot (catches accidental prompt drift).

We do not assert on prose. Real-CLI runs are tagged `@real-cli`, gated by API-key env vars, and only run nightly + before release. Token spend is bounded (~$5/day budget; build fails if exceeded).

### 4.3 Snapshot tests (compile-only, no run)

Every `(agent, skill-set, runner)` combination produces a snapshot of the *compiled prompt* (text + attachments + runner args). Snapshots live next to the test. A snapshot diff in a PR requires a `prompt-changed` label and reviewer acknowledgment — this stops accidental prompt churn from sneaking through.

---

## 5. Per-agent test matrix

For every agent in [`AGENT_ARCHITECTURE.md` §4](./AGENT_ARCHITECTURE.md#4-per-agent-specs), at minimum:

| Test | Layer | Asserts |
|---|---|---|
| Compiled-prompt snapshot, runner=claude | L1 | `contentHash` stable; attachments correct. |
| Compiled-prompt snapshot, runner=codex | L1 | Same with Codex layout. |
| Happy path against fixture | L2 | Expected GitHub artifacts produced; Evidence Pack complete; audit log has expected `kind` rows. |
| Failure: timeout | L2 | Run reaches `failed` with `error_code='TIMEOUT'`; worktree retained 24h. |
| Failure: Evidence Pack incomplete | L2 | Run reaches `paused` with `error_code='EVIDENCE_INCOMPLETE'`; comment posted on source issue; *no* PR opened. |
| Failure: mode downgrade mid-run | L2 | Run aborts cleanly; worktree discarded; no commit pushed; comment posted. |

### 5.1 Agent-specific cases

| Agent | Extra cases |
|---|---|
| **QA Hunter** | Dedup against existing `obelisk:fix` issue (fuzzy title match). Test runner missing → friendly error. Repo too large → shards via `context-engineering` skill. |
| **Manual QA** | Non-bug oracle match → no issue filed (`non-bug-trap` fixture). Low repro confidence (<0.7) → no issue filed. Missing seeded user → files an issue against `qa/test-users.md`, not the suspected bug. |
| **Bug Fixer** | Repro fails → `paused` with `REPRO_FAILED`. Tests pass after failing test added → `done` with `confirmed_not_a_bug`. Push rejected (mock branch protection) → `failed` with `PUSH_REJECTED`. |
| **Feature Builder** | Resume with `obelisk:continue` after `paused` resumes from last completed step (assert the `define` step is not re-run). 3 build/test loops exhausted → `paused` with `TEST_LOOP_EXHAUSTED`. Spec ambiguous → questions posted to issue. |
| **PR Reviewer** | Cross-evidence-check fails (faked PR with empty `## Evidence`) → `REQUEST_CHANGES` with missing-item list. Diff too large → `COMMENT` review with partial-coverage note. Force-push during review → re-queued for new HEAD. |

---

## 6. Evidence-check tests

The Evidence-check rule engine ([`TECH_DESIGN.md` §9](./TECH_DESIGN.md#9-evidence-pack-pipeline)) gets its own L1 suite that covers every row of [`PRD.md` §7.2](../PRD.md#72-pr-evidence-pack-no-pr-ships-without-proof):

| Change type | Synthetic input | Expected verdict |
|---|---|---|
| `bug_fix` complete | failing test, passing test, full output | `pass` |
| `bug_fix` no failing test | passing test, full output | `fail` (missing `failing_test_diff`) |
| `bug_fix` UI touched, no screenshot | failing+passing test, output, no screenshot | `fail` (missing `ui_screenshot_if_ui_touched`) |
| `new_feature` complete with backend | new tests, output, screenshot, curl log | `pass` |
| `new_feature` UI feature, no screenshot | new tests, output, no screenshot | `fail` |
| `new_feature` backend feature, no log/curl | new tests, output, no log | `fail` |
| `refactor` no UI touch | output only | `pass` |
| `refactor` UI touched, only one screenshot | output, single screenshot | `fail` (need before+after) |
| `ui_only` complete | one screenshot | `pass` |
| Empty `## Evidence` block in PR body | … | `fail` (PR-body lint catches it before file check) |

Plus property-style tests: random valid Evidence Packs always `pass`; randomly removing one required item always `fail`s.

---

## 7. Schedule + scheduler tests

| Case | Layer | Assertion |
|---|---|---|
| Built-in defaults fire at the right cadence | L1 | With a fake clock, each agent's `nextFireAt` lands in the expected window (PRD §6.2). |
| Per-agent schedule override | L1 | Custom cron in `agents.schedule_cron` wins over the built-in default. |
| Heartbeat reaper | L1 | A run with `last_heartbeat_at` older than 2× timeout transitions to `failed` on next tick. |
| Quit-resume parity | L2 | Quit the app between ticks; relaunch; assert no run was missed *and* no run was double-fired. |
| OS-level fallback dispatches | L3 | With cloud-execution toggle off but "run when closed" on, the headless invocation processes a due run. (Stubbed launchd/Task Scheduler in CI; real on macOS-only manual run.) |
| Cloud reconciliation | L2 | A workflow run finished in the (mocked) GitHub Actions API is imported into local SQLite with `trigger='cloud'`. |

---

## 8. OAuth + safety-gate tests

The most security-relevant suite. Every test either *succeeds* without writing or *fails* in a way that cannot be silenced.

| Case | Layer | Assertion |
|---|---|---|
| Sign-in via Device Flow (mocked) | L1 | Token lands in keychain (mocked); `auth:status` reflects scope. |
| Observe-only mode rejects writes | L2 | With a mock GitHub API that returns 403 for write endpoints when given an Observe-only token, *and* with the local mode set to Observe, every attempt to call `gh.issues.create` returns `MODE_TOO_LOW` from the local check *before* hitting the API (defense in depth). |
| Mode upgrade triggers re-auth | L1 | Setting `mode='prs'` while OAuth scope = read-only returns `AUTH_REQUIRED` until `auth:upgradeScope` succeeds. |
| Mode downgrade aborts live run | L2 | Mid-run mode change from `prs` to `observe` causes the runner to abort at next checkpoint, discard worktree, leave no commit. |
| Token absent | L1 | All write IPC handlers return `AUTH_REQUIRED`. |
| Token expired | L1 | Refresh flow runs; if refresh fails, return `AUTH_REQUIRED` and clear keychain. |
| Auto-merge gate | L2 | A draft PR with green checks but no `obelisk:automerge` label does *not* merge, even with mode = `automerge`. With the label *and* mode, it merges. |

---

## 9. End-to-end smoke (PRD §11)

The 18-step verification plan from [`PRD.md` §11](../PRD.md#11-verification-plan) is automated as a single Playwright suite (`e2e/smoke.spec.ts`) that runs against the packaged Electron build. Each PRD step maps to one Playwright step. Highlights:

- **Step 1** — launch packaged binary, click *Sign in to GitHub*, intercept Device Flow, complete with a fixture token.
- **Step 5** — assert `qa/` PR opens with ≥3 flow files and product-map.
- **Step 6** — Manual QA filing test: assert one issue *is* filed for the seeded persistence bug and *no* issue is filed for the upgrade-modal non-bug.
- **Step 7** — backlog drag-and-drop changes the order Bug Fixer pulls from on the next scheduled tick.
- **Step 9** — assert the Bug Fixer PR contains the four `## Evidence` subheadings, all populated.
- **Step 11a** (negative test) — delete the screenshot artifact from the agent's output before publish; assert the run pauses with `EVIDENCE_INCOMPLETE` and *no* PR is opened.
- **Step 16** — assert each commit's author matches the local git config and the trailer contains `Co-Authored-By: Obelisk`.
- **Step 17** — quit the app between scheduled ticks; relaunch; assert no run is duplicated.
- **Step 18** — toggle cloud execution on; assert workflow files are pushed; intercept Actions API to feed back a fake run; assert it lands in Mission Control with `trigger='cloud'`.

The smoke suite is release-blocking: a failed step blocks the next stable release.

---

## 10. CI matrix

| Axis | Values |
|---|---|
| OS | macOS-latest, windows-latest, ubuntu-latest |
| Node | LTS (current) + LTS-1 |
| CLI versions | Pinned `claude` + `codex` versions per release; matrix sweeps each on nightly |
| Test layer | L1 + L2 on every PR; L2-real + L3 nightly + on `release/*` branches |

Per-PR cost target: < 4 min wall-clock for the L1+L2 suite. Nightly: < 30 min including L2-real and L3 across all OSes.

Release-blocking suites: L1, L2, L2-real, L3, evidence-check (§6), oauth+safety (§8), e2e smoke (§9).

---

## 11. Flake budget & quarantine policy

- Any test that fails twice within 30 days for non-product reasons gets the `flaky` label automatically and is re-run twice in CI before it counts as a failure.
- A `flaky` test must be either fixed or deleted within 14 days. No permanent `flaky`-label hideouts.
- The smoke suite (§9) has *zero* flake tolerance — a flake there blocks the release until root-caused.

---

## 12. Local developer workflow

```bash
pnpm install
pnpm test              # L1 + L2 with mocks. Fast.
pnpm test:watch        # L1 only, in watch mode.
pnpm test:real         # L2-real. Requires CLI API keys in env.
pnpm test:e2e          # L3 against the dev build of the Electron app.
pnpm test:e2e:packaged # L3 against the packaged binary (slower, closer to CI).

pnpm test:record <fixture-name>   # Re-record GitHub cassettes for a fixture.
pnpm test:snapshots:update         # Update prompt snapshots (requires `prompt-changed` PR label).
```

A pre-commit hook runs the L1 suite for files touched in the commit. A pre-push hook runs the full L1 + L2 suite. Both can be skipped with `--no-verify` for emergency pushes; the CI matrix is the authoritative gate.
