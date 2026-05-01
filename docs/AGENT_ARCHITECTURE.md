# Obelisk — Agent Architecture

**Status:** Draft for the initial release.
**Audience:** Contributors implementing or modifying Obelisk agents.
**Companion docs:** [`PRD.md`](../PRD.md) (requirements) · [`TECH_DESIGN.md`](./TECH_DESIGN.md) (substrate the agents run on).

This document is the canonical reference for *what each agent reads, what it produces, and how it transitions between states.* If you are adding a new agent, copy the per-agent template (§4) and fill it in.

---

## 1. The universal agent shape

Every Obelisk agent is the same five-step pipeline:

```
inputs ──▶ prompt compiler ──▶ CLI subprocess ──▶ outputs ──▶ publisher
                                  (claude or codex)
```

| Step | Owned by | Where it lives |
|---|---|---|
| Inputs | Job runner, agent's `Inputs` table (§4) | SQLite + repo files + GitHub API |
| Prompt compiler | Main process | [`TECH_DESIGN.md` §7](./TECH_DESIGN.md#7-prompt-compiler) |
| CLI subprocess | Job runner | [`TECH_DESIGN.md` §8](./TECH_DESIGN.md#8-job-runner--cli-subprocess-contract) |
| Outputs | Agent code (parsing the run result) | Patches, test runs, screenshots, reasoning |
| Publisher | Main process | Evidence-check ([`TECH_DESIGN.md` §9](./TECH_DESIGN.md#9-evidence-pack-pipeline)) → git push → GitHub API |

The agent itself is *not* a long-running process. An agent is a Markdown definition (`agents/<name>.md`) plus a thin TypeScript handler that:

1. Maps its inputs to a `TaskPayload`.
2. Selects skills.
3. Interprets the run result (e.g., extracts the failing-test diff for the Evidence Pack).
4. Decides outputs (file an issue vs. open a PR vs. post a review).

Everything else is shared infrastructure.

The five agents shipped in the initial release are listed in [`PRD.md` §3.1](../PRD.md#31-five-agents): **QA Hunter**, **Manual QA**, **Bug Fixer**, **Feature Builder**, **PR Reviewer**.

---

## 2. Universal data sources

For *every* agent run, the following inputs are gathered before the prompt is compiled. Per-agent specs in §4 list which subset each agent reads.

| Source | Path / table | What's pulled |
|---|---|---|
| **Agent definition** | `agents/<name>.md` (in user repo, version-controlled) | Role, mission, default skills, permissions, output format, schedule. Falls back to the built-in shipped with the app if absent in the repo. |
| **Skill library** | `skills/<skill>/SKILL.md`. Lookup order: per-repo override → built-in catalog under `<app-support>/Obelisk/skills/`. | The named skill bodies the agent will load. The catalog is [Addy Osmani's `agent-skills`](https://github.com/addyosmani/agent-skills) shipped with the app. |
| **QA Playbook** | `qa/` in the user repo (committed at *File issues* mode and above; dashboard-only draft in *Observe only*). See [`PRD.md` §3.5](../PRD.md#35-qa-playbook). | `product-map.md`, `critical-flows.md`, `expected-behavior.md`, `bug-rules.md`, `non-bugs.md`, `test-users.md`, `playwright/flows/*.flow.md`. |
| **Repo state** | Local clone working tree + `git log` + `gh` API | File tree, recent commits since last successful run for this agent, open issues/PRs, labels, branch state. |
| **Backlog** | SQLite `backlog` (see [`TECH_DESIGN.md` §4.1](./TECH_DESIGN.md#41-tables)) | Next item this agent should work on, with optional `agent_override` and `runner_override`. Bug Fixer + Feature Builder only. |
| **Settings** | SQLite `settings` + OAuth scope from keychain | Current safety mode, default runner, attribution mode, schedule overrides, cloud-execution flag. |
| **Prior runs / memory** | SQLite `runs`, `audit_log`, `non_bugs_learned` | Previous decisions on similar issues, learned non-bug rules (so QA Hunter / Manual QA don't refile). |
| **GitHub task** | The triggering issue / PR via GitHub API | Title, body, labels, comments, attached PR diff (for PR Reviewer). |

Inputs are gathered into a `TaskPayload` and passed to the prompt compiler ([`TECH_DESIGN.md` §7](./TECH_DESIGN.md#7-prompt-compiler)). Anything not in this table is *not* an agent input — agents do not have arbitrary network access, do not read the user's home directory, and do not see other repos' data.

---

## 3. Cross-agent contracts

These conventions are shared by all agents and enforced by the publisher.

### 3.1 GitHub labels

| Label | Set by | Meaning |
|---|---|---|
| `obelisk:fix` | User (manual) or QA Hunter / Manual QA when filing | "Bug Fixer should pick this up." |
| `obelisk:feature` | User | "Feature Builder should pick this up." |
| `obelisk:in-progress` | Publisher when a run starts | Locks the issue against duplicate runs. Removed when run finishes (any state). |
| `obelisk:automerge` | User | Combined with the *Auto-merge safe fixes* mode + green checks, allows auto-merge of the produced PR. |
| `obelisk:continue` | User | Resumes a `paused` Feature Builder or Bug Fixer run from its last checkpoint. |
| `obelisk:false-positive` | User (closing an issue) | Triggers a write to `non_bugs_learned`. |
| `obelisk:cloud-only` | User | Forces this issue's runs to use cloud execution (skipped if the local app picks it up). |

### 3.2 Commit subject format

Every Obelisk-produced commit ends with `[obelisk:<agent-name>]`:

```
fix(auth): preserve Safari session cookie [obelisk:bug-fixer]
test(reports): add CSV-export integration test [obelisk:feature-builder]
```

This is greppable, survives squash-merges if the project preserves subjects, and makes audit easy. Generated maintenance commits (records, dashboards) additionally include `[skip ci]`.

### 3.3 Branch naming

Per-run worktrees branch from `default_branch` and push to `obelisk/<run-id>` (a ULID). Multiple runs against the same issue produce distinct branches; the publisher links them in the PR description.

### 3.4 Artifact paths

The publisher mirrors PR-referenced artifacts to the repo:

```
.obelisk/records/
  issues/<issue-number>/<run-id>/
  prs/<pr-number>/<run-id>/
  commits/<short-sha>/<run-id>/
  playwright-traces/<run-id>/
```

Local-only artifacts (large traces, raw logs) stay under `<app-support>/Obelisk/records/<repo-id>/<run-id>/` and are linked from the PR body via `obelisk://` URIs that the desktop app handles.

### 3.5 Run state machine (shared)

Every run progresses through:

```
queued → running → publishing → done
                              ╲
                               → paused (Evidence-check failed, mid-run mode downgrade, or `obelisk:continue` requested)
                              ╲
                               → failed (timeout, crash, repeated runner failure, mode disallows publish)
```

`paused` runs can be resumed by labeling the source issue `obelisk:continue` (Feature Builder, Bug Fixer) or by manual action from Mission Control. `failed` runs are terminal but keep their worktree for 24h to ease debugging.

### 3.6 Audit-log entries (shared kinds)

All agents emit these entries to `audit_log`. Per-agent specs note any additional kinds.

| `kind` | Payload |
|---|---|
| `state` | `{ from, to }` — every state transition. |
| `tool_call` | `{ tool, args }` — CLI tool invocations the runner reports. |
| `file_read` | `{ path, bytes }` |
| `file_write` | `{ path, bytes, sha256 }` |
| `test_run` | `{ command, exitCode, durationMs, summary }` |
| `api_call` | `{ method, urlRedacted, status, latencyMs }` |
| `reasoning` | `{ summary, fullRefHash }` — full text in `evidence_artifacts`. |

---

## 4. Per-agent specs

Each spec uses the same template:

> **Mission** — one sentence from PRD.
> **Inputs** — table of source → path/table → field used.
> **Skills loaded** — names from [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills).
> **Default runner** — Claude Code or Codex.
> **State machine** — agent-specific transitions, beyond the shared §3.5.
> **Outputs** — what hits GitHub.
> **Failure modes & recovery**
> **Audit-log additions** — kinds beyond §3.6.

---

### 4.1 QA Hunter

**Mission:** Static + test-suite inspection. Read code, run tests, find weak areas and likely bugs. (PRD §3.1)

**Inputs:**

| Source | Path / table | Field used |
|---|---|---|
| Agent definition | `agents/qa-hunter.md` | role, mission, output format |
| Skills | `skills/code-review-and-quality/SKILL.md`, `skills/security-and-hardening/SKILL.md`, `skills/debugging-and-error-recovery/SKILL.md`, `skills/test-driven-development/SKILL.md` | full skill body |
| QA Playbook | `qa/product-map.md`, `qa/bug-rules.md`, `qa/non-bugs.md` | product description; oracle rules; learned exclusions |
| Repo state | Local clone + `git log` | file tree, files changed since last QA Hunter run, test runner config |
| Settings | `settings` (`scope='repo:<id>'`) | runner override, mode |
| Memory | `non_bugs_learned` | rules to skip |
| GitHub | `gh` API | open issues already labeled `obelisk:fix` (avoid duplicates) |

**Skills loaded:** `code-review-and-quality`, `debugging-and-error-recovery`, `test-driven-development`, `security-and-hardening`.

**Default runner:** Claude Code (heavy analytic load; switch to Codex per-agent if preferred).

**State machine (additions):**

```
running:
  scanning → running-tests → triaging → preparing-issues
```

**Outputs:** Zero or more GitHub issues, each with: severity (`P0`/`P1`/`P2`), repro steps if known, suspected files, suggested test idea. Filed only in modes ≥ *File issues*. In Observe mode, written to the dashboard preview store.

No PRs, no commits.

**Failure modes & recovery:**

| Failure | Behavior |
|---|---|
| Test command not found | Run is marked `failed` with `error_code='TEST_RUNNER_MISSING'`; the renderer prompts the user to set the test command in agent settings. |
| Repo too large for context | Agent shards by directory via skill `context-engineering`; if still too large, reports partial scan and a "needs sharding" issue. |
| Issue already exists (title fuzzy-match >0.85) | Skip filing; record as `audit_log` `kind='dup_skipped'`. |

**Audit-log additions:**

- `kind='qa_finding'` — `{ severity, suspectedFiles, oracleMatched, learnedRuleSkipped? }` for each candidate, before filing.

---

### 4.2 Manual QA

**Mission:** Drive the app like a user via Playwright. Replay critical flows, capture evidence, file an issue only when evidence is strong. (PRD §3.1)

**Inputs:**

| Source | Path / table | Field used |
|---|---|---|
| Agent definition | `agents/manual-qa.md` | role, mission, output format |
| Skills | `skills/browser-testing-with-devtools`, `skills/debugging-and-error-recovery` | skill body |
| QA Playbook | `qa/critical-flows.md`, `qa/expected-behavior.md`, `qa/bug-rules.md`, `qa/non-bugs.md`, `qa/test-users.md`, `qa/playwright/flows/*.flow.md` | flows to run, expected behaviors, oracles, seeded users |
| Settings | `settings` | configured base URL for the app, mode, runner |
| Memory | `non_bugs_learned` | rules to skip |
| GitHub | `gh` API | open Manual QA issues (dedup) |

**Skills loaded:** `browser-testing-with-devtools`, `debugging-and-error-recovery`. Note: the agent does not load `test-driven-development` — Manual QA *files* bugs, it does not write tests.

**Default runner:** Codex (faster iteration on Playwright loops; Claude Code per-agent override is fine).

**State machine (additions):**

```
running:
  preparing-env → running-flow[i] → comparing-to-expected → preparing-evidence
```

The agent loops `running-flow[i]` over each flow in `critical-flows.md`. Each flow run produces a Playwright trace, screenshot, console log, network log.

**Outputs:** Zero or more GitHub issues, each with:

- Title: `[QA Bug] <flow>: <symptom>`
- Body sections: `Evidence` (screenshot, trace link, console excerpt, network excerpt), `Repro`, `Severity`, `Likely area`, `Repro confidence (%)`.
- Issue is filed only if `repro_confidence >= 0.7` *and* the symptom is not in `non-bugs.md` *and* a similar issue is not already open.

In Observe mode, the issue body is generated and shown as a dashboard preview with a *Promote to GitHub Issue* button.

**Failure modes & recovery:**

| Failure | Behavior |
|---|---|
| Base URL unreachable | Run paused; prompts the user to launch the app or configure the URL. |
| Flow file references a missing test user | Issue is filed against `qa/test-users.md` instead, asking the user to seed the account. |
| Playwright crashes mid-flow | Flow marked `inconclusive`; agent moves on; no issue is filed for that flow. |
| `non-bugs.md` rule matched | Logged as `audit_log` `kind='oracle_skipped'`; no issue. |

**Audit-log additions:**

- `kind='flow_run'` — `{ flow, outcome: 'pass'|'fail'|'inconclusive', durationMs, traceArtifactId }`.
- `kind='oracle_skipped'` — `{ flow, rule, ruleSource: 'non-bugs.md'|'non_bugs_learned' }`.

---

### 4.3 Bug Fixer

**Mission:** Take one `obelisk:fix` issue → write failing test → fix → open PR. (PRD §3.1)

**Inputs:**

| Source | Path / table | Field used |
|---|---|---|
| Agent definition | `agents/bug-fixer.md` | role, mission, output format |
| Skills | `skills/debugging-and-error-recovery`, `skills/test-driven-development`, `skills/incremental-implementation`, `skills/git-workflow-and-versioning` | skill body |
| QA Playbook | `qa/expected-behavior.md`, `qa/bug-rules.md`, `qa/test-users.md` | what counts as a fix; how to drive a flow |
| Backlog | `backlog` | next `kind='bug'` item not `in_progress`, respecting `user_pin_rank`/`priority_label` ordering |
| GitHub task | issue body, comments, attached repro, screenshots | the bug being fixed |
| Repo state | Local clone | source files, test runner config, package manifest |
| Settings | `settings` | mode, runner override, attribution mode |
| Prior runs | `runs`, `audit_log` | previous attempts at this issue (for `obelisk:continue`) |

**Skills loaded:** `debugging-and-error-recovery`, `test-driven-development` ("Prove-It Pattern": failing test before any code change), `incremental-implementation`, `git-workflow-and-versioning`.

**Default runner:** Claude Code.

**State machine (additions):**

```
running:
  reproducing → writing-failing-test → fixing → verifying → packing-evidence
publishing:
  evidence-check → committing → pushing → opening-pr
```

`reproducing` is a hard gate: if the agent cannot produce a failing test that matches the bug, it transitions to `paused` with `error_code='REPRO_FAILED'` and posts a comment on the issue asking for clearer repro steps.

**Outputs:** A draft PR with:

- Branch `obelisk/<run-id>` based on `default_branch`.
- One commit containing the failing test (Prove-It step).
- One or more commits containing the fix (vertical slices).
- One commit updating any QA Playbook entries the fix invalidates.
- PR body with the standard `## Evidence` block ([`TECH_DESIGN.md` §9](./TECH_DESIGN.md#9-evidence-pack-pipeline)) — required items per [`PRD.md` §7.2](../PRD.md#72-pr-evidence-pack-no-pr-ships-without-proof) for `bug_fix`: failing→passing test diff, full test output, before/after screenshot if UI was touched.

PR is `draft` always; auto-merge is decided by repo mode + `obelisk:automerge` label.

**Failure modes & recovery:**

| Failure | Behavior |
|---|---|
| Cannot reproduce | `paused`, `error_code='REPRO_FAILED'`. Comment on issue. User can re-trigger with better steps. |
| Tests pass after the failing test added (false bug) | Run marked `done` with output `confirmed_not_a_bug`. Comment posted; issue auto-closed if user has enabled that setting. |
| Evidence Pack incomplete | `paused`, `error_code='EVIDENCE_INCOMPLETE'`. Comment lists missing items. |
| Push rejected (branch protection) | `failed`, `error_code='PUSH_REJECTED'`. Local worktree retained 24h. |
| Mode downgraded mid-run | Aborts cleanly; worktree discarded; comment posted: "Run aborted due to mode change." |
| Runner crashed twice | Auto-fallback to other runner ([`TECH_DESIGN.md` §8.3](./TECH_DESIGN.md#83-auto-fallback)). |

**Audit-log additions:**

- `kind='repro_attempt'` — `{ outcome, failingTestPath?, why? }`.
- `kind='evidence_check'` — `{ result: 'pass'|'fail', missing?: [...] }`.

---

### 4.4 Feature Builder

**Mission:** Take one `obelisk:feature` issue → run the full **DEFINE → PLAN → BUILD → TEST → REVIEW → SHIP** loop → open PR. (PRD §3.1, §5.2)

**Inputs:**

| Source | Path / table | Field used |
|---|---|---|
| Agent definition | `agents/feature-builder.md` | role, mission, output format, loop step list |
| Skills | the full lifecycle chain: `idea-refine`, `spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `code-review-and-quality`, `code-simplification`, `shipping-and-launch`. Plus practice skills as needed: `api-and-interface-design`, `frontend-ui-engineering`, `documentation-and-adrs`, `source-driven-development`. | skill body |
| QA Playbook | all of `qa/` | so generated tests align with the contract |
| Backlog | `backlog` | next `kind='feature'` item not `in_progress` |
| GitHub task | issue title + body | the feature request, possibly one-line |
| Repo state | Local clone + recent commits + READMEs | conventions, frameworks, code style |
| Settings | `settings` | mode, runner override |
| Prior runs | `runs`, `audit_log` | for `obelisk:continue` resumes from last completed step |

**Skills loaded:** lifecycle (8) + practice (4) listed above.

**Default runner:** Claude Code (longest-context jobs).

**State machine (the loop is the state machine):**

```
running:
  define   (uses idea-refine + spec-driven-development) → posts spec.md as a comment on the issue
  plan     (uses planning-and-task-breakdown)            → posts task list as a comment
  build    (uses incremental-implementation)             → vertical slices, one commit per slice
  test     (uses test-driven-development)                → writes + runs tests; failures loop back to build (max 3)
  review   (uses code-review-and-quality)                → self-review pass; cosmetic fixes
publishing:
  evidence-check → committing-final → pushing → opening-pr   (uses shipping-and-launch for the PR description)
```

Each step is its own CLI invocation with its own compiled prompt. State persists between steps via comments on the issue (the source of truth visible to the user) plus `audit_log` and the run's worktree.

**Resumability:** if a step fails or the user labels the issue `obelisk:continue` after a `paused` state, the agent restarts from the last completed step using the artifacts already produced.

**Outputs:** A draft PR with:

- Branch `obelisk/<run-id>`.
- One commit per vertical slice (small, reviewable).
- A spec + plan attached as comments on the source issue (for context).
- PR body with the standard `## Evidence` block — required items per PRD §7.2 for `new_feature`: new tests + full test output, end-to-end Playwright screenshot of the working feature, server-log/curl excerpt proving the new code path executed.

**Failure modes & recovery:**

| Failure | Behavior |
|---|---|
| Spec is ambiguous after `define` | `paused`, `error_code='SPEC_AMBIGUOUS'`. Posts the questions to the issue, asks user to clarify. Resume with `obelisk:continue`. |
| Test failures after 3 build/test loops | `paused`, `error_code='TEST_LOOP_EXHAUSTED'`. Partial diff + reasoning posted; user can resume or close. |
| Evidence Pack incomplete (e.g., missing UI screenshot for a UI feature) | `paused`, `error_code='EVIDENCE_INCOMPLETE'`. |
| Push rejected | `failed`, same as Bug Fixer. |
| Runner crashed twice on the same step | Auto-fallback per [`TECH_DESIGN.md` §8.3](./TECH_DESIGN.md#83-auto-fallback). |

**Audit-log additions:**

- `kind='loop_step'` — `{ step: 'define'|'plan'|'build'|'test'|'review', outcome: 'ok'|'retry'|'paused', durationMs }`.
- `kind='spec_posted'`, `kind='plan_posted'` — issue-comment IDs for traceability.

---

### 4.5 PR Reviewer

**Mission:** Review every PR like a staff engineer (5-axis: correctness, design, tests, security, perf). (PRD §3.1)

**Inputs:**

| Source | Path / table | Field used |
|---|---|---|
| Agent definition | `agents/pr-reviewer.md` | role, mission, output format |
| Skills | `skills/code-review-and-quality`, `skills/security-and-hardening`, `skills/test-driven-development` (to evaluate test quality) | skill body |
| GitHub task | the PR diff, commit messages, linked issues, PR description (including the `## Evidence` block) | the change to review |
| Repo state | Local clone | conventions, neighboring code |
| QA Playbook | `qa/expected-behavior.md`, `qa/bug-rules.md` | does the change preserve expected behavior? |
| Prior runs | `runs` | previous reviews on the same PR (for force-push iterations) |

**Skills loaded:** `code-review-and-quality`, `security-and-hardening`, `test-driven-development`.

**Default runner:** Claude Code.

**State machine (additions):**

```
running:
  fetching-pr → analyzing-diff → cross-checking-evidence → composing-review
publishing:
  posting-review
```

`cross-checking-evidence` is the rule that distinguishes Obelisk's PR Reviewer from a generic LLM reviewer: it verifies the `## Evidence` block exists and that its claimed artifacts resolve. A PR with a missing or fabricated Evidence Pack is hard-blocked with `event='REQUEST_CHANGES'` and a comment citing exactly which item is missing (per PRD §7.2 enforcement).

**Outputs:** One GitHub PR review per run:

- `event` ∈ `APPROVE` | `REQUEST_CHANGES` | `COMMENT`.
- Top-level summary; inline comments anchored to specific lines for issues.
- A short `## Verdict` block at the bottom: `Confidence`, `Risk areas`, `Suggested follow-ups`.

PR Reviewer never opens its own PR; it never modifies code.

**Failure modes & recovery:**

| Failure | Behavior |
|---|---|
| Diff too large for context | Reviews high-risk hunks (security-sensitive paths, public APIs) and posts a `COMMENT` review noting partial coverage. |
| Force-push during review | Aborts current review; re-queued for the new HEAD. |
| Author is Obelisk itself | Reviews proceed normally — Obelisk reviews Obelisk PRs the same way it reviews human ones (this is the Evidence-Pack enforcement loop). |
| Evidence Pack missing or broken | Posts `REQUEST_CHANGES` with the missing-item list. |

**Audit-log additions:**

- `kind='review_finding'` — one row per inline comment: `{ path, line, category, severity }`.
- `kind='evidence_cross_check'` — `{ result: 'ok'|'missing'|'broken', items }`.

---

## 5. Adding a new agent (checklist)

To add an agent (e.g., a `Security Auditor` from PRD §4 marketplace):

1. **Pick a name.** Single token, kebab-case (`security-auditor`).
2. **Write `agents/security-auditor.md`** — role, mission, default skills, permissions, output format. Use existing definitions as templates.
3. **Add a TypeScript handler** in `src/agents/security-auditor/` implementing the `Agent` interface:
   - `selectTask(repo): Promise<TaskPayload | null>` — what is this agent's "next thing to do"?
   - `interpretResult(runResult): Outputs` — what GitHub artifacts does this run produce?
4. **Register the agent** in the agent registry. The registry is the only place that needs to know about new agents; the prompt compiler, runner, and publisher are name-agnostic.
5. **Pick a default schedule** — add a row to the built-in schedule config in `TECH_DESIGN.md` §6.
6. **Define labels** if the agent uses any beyond §3.1.
7. **Define required Evidence Pack items** if the agent's outputs include PRs/commits — extend the rule table in `TECH_DESIGN.md` §9.1.
8. **Add tests:**
   - Snapshot test for `(agent, default-skills, claude)` and `(…, codex)` compiled prompts.
   - Happy-path integration test against a fixture repo.
   - Three failure-mode tests (timeout, missing evidence, mode downgrade).
   - See [`TEST_PLAN.md` §6](./TEST_PLAN.md#6-per-agent-test-matrix).
9. **Document** by appending a §4.x section here following the per-agent template.

The agent system is intentionally name-agnostic in the substrate; "adding an agent" should require no changes to the runner, scheduler, prompt compiler, or publisher.
