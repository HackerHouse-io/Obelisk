# Obelisk — Product Requirements Document

## Context

Solo founders and small teams now ship at the velocity of large eng orgs by running fleets of AI coding agents in parallel — the highest-output indie devs are pushing 100–200 commits/day through scheduled, sharded agent jobs that file issues, open PRs, and self-heal CI. Today this is a DIY exercise: hand-rolled TypeScript scripts, hand-written GitHub Actions YAML, and per-team prompt glue. Every team that wants it rebuilds it from scratch.

**Obelisk** turns that pattern into an open-source desktop application — Electron + React, runs on the user's own machine, integrates with GitHub locally. There is no Obelisk-hosted backend, no SaaS, no telemetry: the user signs in to GitHub from the app, picks a local repo clone (or clones one through the app), chooses agents and a safety level, and walks away. Agents run as local subprocesses against the user's own checkout; the app commits, pushes, and opens issues/PRs through the GitHub API on the user's behalf.

It is **CLI-runner agnostic**: every agent in Obelisk runs on either **Claude Code CLI** or **Codex CLI** (user choice, per agent or global default), so teams keep their existing model/billing relationship. Bring your own API key — it never leaves the user's machine.

Positioning: **"Your repo finally maintains itself."** Not "AI agents for GitHub."

---

## 1. Target user & job-to-be-done

**Primary persona:** Indie founder / staff eng / small startup CTO who:
- Owns 1–10 GitHub repos.
- Already pays for Claude Code or Codex (or both).
- Feels the pain: *"My issues pile up. My tests are weak. My PRs take too long. AI tools help but I still drive everything manually."*

**JTBD:** "Give me a small AI engineering team that QAs my app, files real bugs, fixes the safe ones, reviews every PR, and only escalates the decisions I actually need to make."

---

## 2. Core user flow

```
Connect repo → Pick agents → Set safety level → Walk away
        ↓
Wake up to: GitHub issues with repro steps + draft PRs with passing tests + PR review comments
```

Three things must be true on day one:
1. **No YAML.** User never opens `.github/workflows/*.yml`.
2. **GitHub-native outputs.** Agents write issues, PRs, comments — not chat messages.
3. **Safe by default.** First run = "observe + create issues only." User opts into PRs and auto-merge.

---

## 3. Initial release scope

### 3.1 Five agents
| Agent | Mission | Output | Default schedule |
|---|---|---|---|
| **QA Hunter** | Static + test-suite inspection. Reads code, runs tests, finds weak areas and likely bugs. | GitHub issue (severity, repro, suspected files, test idea) | Nightly |
| **Manual QA** | Drives the app like a user via Playwright. Replays critical flows from the QA Playbook, captures screenshot/trace/console/network logs, compares actual vs. expected. Files an issue only when evidence is strong. | GitHub issue with Playwright trace + screenshot + repro confidence score | Hourly (top flows) + nightly (full suite) |
| **Bug Fixer** | Take one `obelisk:fix` labeled issue → write failing test → fix → open PR | Draft PR with the **Evidence Pack** (§7.2): failing→passing test diff, full test command output, before/after Playwright screenshots when UI is touched, relevant logs | Every 2 hours |
| **Feature Builder** | Take one `obelisk:feature` labeled issue → run the full **DEFINE → PLAN → BUILD → TEST → REVIEW → SHIP** loop → open PR | Draft PR with spec, plan, vertical-slice diff, plus the **Evidence Pack** (§7.2): new tests + their output, Playwright screenshot of the feature working end-to-end, server/API log proving the new code path executed | Every 6 hours |
| **PR Reviewer** | Review every PR like a staff engineer (5-axis: correctness, design, tests, security, perf) | PR review (approve/block/comment) | On every PR |

Two of these warrant special attention:
- **Feature Builder** extends Obelisk beyond maintenance — it ships tested features end-to-end from a one-line issue.
- **Manual QA** is the agent most prone to false positives without a written contract. It depends on the QA Playbook (§3.5) as its source of truth.

### 3.2 Connect-repo flow (≤6 steps)
1. Sign in to GitHub from the app (OAuth Device Flow; the token is stored in the OS keychain).
2. Add a repo: pick an existing local clone, or clone one from your GitHub account via the app.
3. Choose how much agents are allowed to do — each level adds the actions of the previous one:
   - **Observe only (dry run)** — agents read code, run tests, and crawl the app, but write nothing to GitHub or the repo. Findings appear in the Obelisk dashboard as previews: would-be issues, would-be PRs (with full diff and reasoning), and a draft QA Playbook generated from the crawl. The user can promote any preview to a real GitHub issue or PR with one click. This is the recommended first-run tier — try the agents safely and graduate when comfortable.
   - **File issues** — agents may create real GitHub issues with repro steps and suggested fixes. The QA Playbook is committed to the repo (via PR for human approval) so subsequent runs have a written contract to test against.
   - **Fix bugs and build features** — agents may also open *draft* PRs (Bug Fixer, Feature Builder). Every PR ships with an **Evidence Pack** (§7.2): test output, Playwright screenshots for UI changes, and logs proving the new code path runs. A human still merges.
   - **Auto-merge safe fixes** — Obelisk may merge a draft PR on its own when checks are green and the change matches a safe-fix policy.
4. Choose CLI runner: **Claude Code CLI** / **Codex CLI** (per agent or global).
5. Pick schedule (defaults pre-filled).
6. Start.

### 3.3 Mission Control screen
A pipeline view of every agent run, replacing the chat metaphor:

```
Backlog       → #123 Login error on Safari
Investigating → QA Hunter reading auth/session.ts
Reproduced    → Failing test created
Fixing        → Bug Fixer editing auth/session.ts
Verifying     → pnpm test running
PR Created    → #211 fix(auth): preserve Safari session cookie
Needs Review  → human approval required
```

Every run produces an **audit log**: what the agent did, files read, files changed, tests run, the reasoning behind the fix, and what still needs human review. The audit log is the basis for user trust — it should be complete enough that a reviewer can verify any agent action without re-running it.

### 3.4 "Fix with AI" shortcut
Every issue page in the dashboard (and via GitHub comment `/obelisk fix`) gets one button:

```
Fix with AI ▾
  • Fast fix
  • Careful fix with test
  • Refactor-safe fix
  • Security-sensitive fix
```

Then: Create PR / Create draft PR / Ask before every file change.

### 3.5 QA Playbook

**The problem:** A QA agent that decides "expected behavior" from vibes will file noise. It needs a written contract.

**The solution:** Every connected repo gets a `qa/` folder generated by Obelisk crawling the app on first connect. In *Observe only* mode the generated Playbook lives in the dashboard as a draft for the user to review; in *File issues* and above it is committed to the repo via PR for human approval. The user edits it from there to refine.

```
qa/
  product-map.md          # what the product does, top user stories
  critical-flows.md       # ordered list of flows the agent MUST test
  expected-behavior.md    # per-flow: what counts as correct
  bug-rules.md            # universal "this is always a bug" oracles
  non-bugs.md             # known intentional behavior (e.g., "free users see upgrade modal")
  test-users.md           # seeded accounts + roles for Playwright
  playwright/
    flows/
      login.flow.md       # one Markdown spec per critical flow
      create-project.flow.md
      billing.flow.md
```

Each `*.flow.md` is structured:
```
Flow: Create Project
Steps:
  1. Log in as normal_user
  2. Click "New Project"
  3. Enter name "Test 123"
  4. Click Create
Expected:
  - Project appears in sidebar
  - URL changes to /projects/:id
  - No console errors
  - No failed network request
  - Refresh keeps the project visible
```

**How agents use it:**
- **Manual QA** reads `critical-flows.md` → launches Playwright → runs each flow → compares actuals to `expected-behavior.md` → only files an issue if mismatch + evidence.
- **QA Hunter** reads `product-map.md` to scope which code paths matter.
- **Bug Fixer + Feature Builder** read all of `qa/` so their tests align with the contract.
- Repos without `qa/` get **universal bug rules only** (button does nothing, blank screen, console error, 500, refresh loses state, etc.) and a banner: *"Bootstrap your QA Playbook to catch product-specific bugs."*

**Self-improving memory:** When a user closes an Obelisk-filed issue as "not a bug," the agent appends the rejection rule to `non-bugs.md` via PR. Approving an issue similarly upgrades a heuristic into `bug-rules.md`. This is how QA scales without hand-writing every flow.

### 3.6 Backlog and prioritization

**The problem:** With 5 agents producing issues + features, the user needs to know — and control — which ones the fixers tackle next.

**The Backlog screen** is a single ranked list pulled from three signals (in order):
1. **User pin / drag-to-top** in the Backlog UI (highest priority).
2. **GitHub Project column** — Obelisk reads the project's "Next Up" column when configured.
3. **Auto-rank** by: severity label (`P0`>`P1`>`P2`) → recency → linked-PR-count → `obelisk:feature` vs. `obelisk:fix` user weighting.

What the user sees on Backlog:
```
Next Up (top of queue — agents work this order)
  1. [P0] [bug] Login error on Safari               → Bug Fixer (next run in 38m)
  2. [P1] [feature] CSV export on /reports         → Feature Builder (next run in 2h)
  3. [P1] [bug] Project disappears after refresh   → Bug Fixer
  4. [P2] [feature] Dark mode                      → Feature Builder

Later
  5. [P2] [bug] Tooltip clipped on mobile
  ... (collapsed)
```

User actions per row: **drag to reorder**, **pin to top**, **send to fixer now**, **skip this run**, **convert bug ↔ feature**, **assign agent override** (e.g., force this issue to use Codex CLI).

**How fixers consume it:** Bug Fixer and Feature Builder pull the highest-ranked issue with their matching label that isn't already in flight, on every scheduled run. No issue is worked twice; in-flight issues are locked via the `obelisk:in-progress` label.

**Optional integrations (post-MVP):** Linear / Jira sync (read prioritization from external tracker, write back PR links).

---

## 4. UI surfaces

| Screen | Purpose | Key elements |
|---|---|---|
| **Project Command Center** (home) | Repo health at a glance | Found Bugs · Fix PRs · Needs Human Review · Agent Activity · Repo Health Score |
| **Connect Project** wizard | The 6-step flow above | No YAML exposed |
| **Agent Marketplace** | Browse + install agents as cards | MVP: QA Hunter / Manual QA / Bug Fixer / Feature Builder / PR Reviewer. Post-MVP: Test Engineer, Security Auditor, Product Polish, Docs Writer, Refactor Bot. |
| **Agent Detail** | Configure one agent | Role · Mission · Skills · Permissions (read code / create issues / open PRs / merge) · Schedule · Output format |
| **Mission Control** | Live pipeline + audit log | Backlog → Investigating → Reproduced → Fixing → Verifying → PR Created → Needs Review |
| **Backlog** | Prioritized queue agents work from | Drag-to-rank, pin, "fix now", per-issue agent override (§3.6) |
| **QA Playbook** | Edit the contract Manual QA tests against | `critical-flows.md`, `expected-behavior.md`, `bug-rules.md`, `non-bugs.md`, Playwright flow files (§3.5) |
| **Settings** | Repo-wide config | CLI runner default, safety level, schedules, secrets, label conventions |

Feel: **Linear + GitHub Actions + Datadog**, simplified. Not a chatbot.

---

## 5. Agent system

### 5.1 Skill library (built-in, ~21 skills)
Obelisk ships Addy Osmani's `agent-skills` catalog wholesale as the built-in skill library — these are battle-tested Markdown playbooks that encode senior-engineer workflows. Each skill is a folder with a `SKILL.md` the agent loads on demand.

**Lifecycle skills** (drive the Feature Builder loop): `idea-refine`, `spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `code-review-and-quality`, `code-simplification`, `shipping-and-launch`.

**Engineering practice skills**: `debugging-and-error-recovery`, `source-driven-development`, `api-and-interface-design`, `frontend-ui-engineering`, `browser-testing-with-devtools`, `ci-cd-and-automation`, `git-workflow-and-versioning`, `deprecation-and-migration`, `documentation-and-adrs`, `performance-optimization`, `security-and-hardening`, `context-engineering`, `using-agent-skills`.

Critical pairings:
- **Bug Fixer** → `debugging-and-error-recovery` + `test-driven-development` (Prove-It: failing test before any code change).
- **Feature Builder** → the lifecycle skill chain (see §5.2).
- **PR Reviewer** → `code-review-and-quality` + `security-and-hardening`.

Repos override built-ins by dropping `skills/<name>/SKILL.md` in their tree (project-specific playbooks always win).

### 5.2 Agent definitions (Markdown, version-controlled)
```
agents/
  qa-hunter.md         # role, mission, skills, permissions, output format
  bug-fixer.md
  feature-builder.md
  pr-reviewer.md
skills/                # built-in catalog (21 skills, see §5.1)
  ...
```

**Feature Builder loop** (full DEFINE→PLAN→BUILD→TEST→REVIEW→SHIP cycle):
```
DEFINE  →  /spec   uses idea-refine + spec-driven-development → writes spec.md to issue
PLAN    →  /plan   uses planning-and-task-breakdown            → posts task list to issue
BUILD   →  /build  uses incremental-implementation             → vertical slices, commit per slice
TEST    →  /test   uses test-driven-development                → writes + runs tests
REVIEW  →  /review uses code-review-and-quality                → self-review + fix-ups
SHIP    →  /ship   uses shipping-and-launch                    → opens draft PR with full audit log
```
Each step is a discrete CLI invocation; failure at any step pauses the agent and posts the partial result + error to the issue for human inspection. The user can resume by labeling `obelisk:continue`.

### 5.3 Pluggable CLI runner
Internally Obelisk speaks one interface:

```ts
interface CodingAgentRunner {
  run(opts: {
    repoPath: string
    prompt: string          // compiled from agent.md + skills + task
    permissions: Permissions
    timeoutMs: number
  }): Promise<{ patch, testsRun, logs, reasoning }>
}
```

Two first-class implementations ship in MVP:
- **`ClaudeCodeRunner`** — invokes `claude` CLI in non-interactive mode with a compiled prompt + permissions config. Uses Claude Code's native skills/subagents where possible.
- **`CodexRunner`** — invokes `codex exec` with `--codex-model`, `--codex-reasoning-effort`, `--codex-sandbox`.

Selection rule:
- **Per-agent override** (e.g., Bug Fixer = Claude Code, QA Hunter = Codex).
- **Global default** in Settings.
- **Auto-fallback**: if the chosen runner fails twice on the same task, retry with the other.

The prompt compiler emits the same logical instructions but adapts syntax (Claude Code skills directory vs. Codex prompt blocks).

### 5.4 Worker runtime
Each agent run executes as a **local subprocess** spawned by the Electron main process, working in the user's local clone of the connected repo. Steps per run:
1. Lock the working tree (no concurrent agent runs in the same repo).
2. Spawn the chosen CLI as a child process (`claude` or `codex`), inheriting a sandboxed environment with the user's API key from the OS keychain and the compiled prompt on stdin.
3. Stream stdout/stderr into the local audit log; tests, Playwright, and linters run in the user's normal dev environment.
4. Capture the resulting patch, test output, screenshots, and reasoning trace.
5. If the Evidence Pack (§7.2) is complete, commit using the user's local git config, push the branch, and open the issue/PR via the GitHub REST API.

**Optional cloud execution** for unattended schedules: when the user toggles "Run schedules even when Obelisk is closed," the app pushes a workflow file (`.github/workflows/obelisk-*.yml`) to the connected repo and dispatches runs against the user's GitHub Actions runners. Execution semantics are identical; the local app remains the source of truth and reads results back via the GitHub API.

**OpenHands** is a candidate alternative worker runtime for a future release — it provides a model-agnostic harness with local-model support via Ollama, LM Studio, or vLLM. The initial release stays on the two CLIs to keep scope tight.

---

## 6. Architecture

Obelisk is a **local-first desktop application**. Everything in the diagram below runs on the user's machine; nothing is hosted by the project.

```
Electron renderer (React UI)
  Project Command Center, Agent Marketplace, Mission Control,
  Backlog, QA Playbook editor, Settings

Electron main process (local control plane)
  GitHub auth          — OAuth Device Flow; token in OS keychain
  Scheduler            — in-app cron while the app is running;
                         OS launch agent / scheduled task for off-hours runs
  State + audit store  — local SQLite (runs, logs, backlog, settings)
  Prompt compiler      — agent.md + skills + task → CLI-specific prompt
  Job runner           — spawns Claude Code or Codex CLI subprocesses

Local execution (the user's machine)
  Working dir = the user's local clone of the connected repo
  Tests, Playwright, linters run in the user's normal dev environment
  Commits use the user's local git config; pushes use the OAuth token
  Issues, PRs, and reviews are created via the GitHub REST API

Optional cloud execution (off by default — power feature for 24/7 schedules)
  App pushes .github/workflows/obelisk-*.yml to the connected repo and
  dispatches runs against the user's GitHub Actions runners.
  Same agents, same Evidence Pack, same outputs.

GitHub-native outputs
  GitHub issues, draft PRs, PR review comments, commit messages
```

Why local-first:
- **Privacy.** Source code, API keys, and reasoning traces never leave the user's machine.
- **Zero infra.** No project-hosted services to operate or fund — fits an open-source release.
- **Speed.** Local subprocess invocation is faster than dispatching a CI job.
- **Optional scale-out.** When the user wants 24/7 unattended runs, GitHub Actions is one toggle away — and uses the user's own runner minutes, not ours.

### 6.1 Safety gates
Permission level is set in app **Settings** (per repo, with a global default) and maps to four progressively wider modes from §3.2: *Observe only* / *File issues* / *Fix bugs and build features* / *Auto-merge safe fixes*. Gates are enforced at three layers:

1. **OAuth scope.** *Observe only* uses a read-only token; the others use a read-write token. Changing modes triggers a re-authorize prompt — agents physically cannot exceed the granted scope.
2. **Local job runner.** Before any commit/push/API call, the runner re-checks the current mode in SQLite. A mode downgrade mid-run aborts the run cleanly.
3. **Auto-merge** also requires the PR to carry the `obelisk:automerge` label and have all checks green; missing either, the merge is skipped and a notification is posted.

When optional cloud execution is enabled, the same modes also map to repo secrets (`OBELISK_ALLOW_EXECUTE`, `OBELISK_ALLOW_FIX_PR`, `OBELISK_ALLOW_MERGE`) so the workflow has an authoritative gate independent of the app.

### 6.2 Default schedule
```
Every PR        → PR Reviewer
Every hour      → Manual QA on top 5 critical flows (Playwright)
Every 2 hours   → Bug Fixer pulls top of Backlog with `obelisk:fix`
Every 6 hours   → Feature Builder pulls top of Backlog with `obelisk:feature`
Every night     → QA Hunter deep scan + Manual QA full Playwright suite (mobile + desktop)
Every Sunday    → Exploratory QA (weird inputs, slow network, permissions, empty states)
Manual          → "Run all agents now" / "Fix this PR" / "Build this feature" / "Run agent on issue"
```

---

## 7. Trust & safety

- **Observe-first default.** Day 1 produces issues only. Opening PRs is an explicit toggle.
- **Audit log per run.** Read files, changed files, tests run, reasoning, confidence — all stored, all viewable.
- **Draft PRs by default.** Auto-merge requires both `OBELISK_ALLOW_MERGE` + label `obelisk:automerge` + green checks.
- **Universal bug rules.** QA Hunter ships with built-in oracles ("button does nothing" = bug, "free user sees upgrade modal" = not a bug) so it doesn't file noise on day one.
- **Memory of rejections.** Closing an Obelisk issue as "not a bug" updates per-repo rules so the same false positive doesn't repeat.

### 7.1 Commit attribution

**Goal:** Commits produced by Obelisk agents are attributed to the connected GitHub account so the work shows up under the human owner who authorized and reviewed it, while every PR is transparently disclosed as agent-authored.

Because agents commit through the user's **local git installation**, attribution falls out naturally — Obelisk uses the existing local `user.name` / `user.email` from the repo's git config. No identity machinery, no signed assertions about who the user is.

- Author and Committer = the user's local git config (Obelisk does not override unless explicitly configured to).
- Trailer: `Co-Authored-By: Obelisk <noreply@local>` for transparency.
- Commit subject ends with `[obelisk:<agent-name>]` so agent-produced commits are greppable, e.g.:
  ```
  fix(auth): preserve Safari session cookie [obelisk:bug-fixer]
  ```
- Generated maintenance commits (records, dashboards, audit logs) include `[skip ci]` to avoid burning CI minutes on bot churn.

**PR-level disclosure** — a standard block prepended to every Obelisk-opened PR description:
```
> Authored by Obelisk (Bug Fixer) on behalf of the connected account.
> Runner: Claude Code CLI · Skills: debugging-and-error-recovery, test-driven-development
> Audit log: <link to local audit record>  ·  Confidence: 87%
>
> Reply `/obelisk explain` to receive the full reasoning trace as a comment.
```

**Per-repo attribution settings** (in Settings → Attribution):
- **User-attributed** *(default)* — Obelisk inherits the local git config. Commits are attributed to the connected GitHub account exactly as if the user had typed them.
- **Bot-attributed** — Obelisk overrides the author with a configured "Obelisk Bot" identity stored in app Settings. For teams whose policies require an explicit bot author.
- **Custom identity** — set an alternate name/email per repo (useful for split work/personal commits).

**Safety:** Obelisk only commits with the local git config that already exists on the machine, or with an identity the user has explicitly configured in app Settings. There is no GitHub-side attribution trick — if a commit appears under the user's profile, it is because their normal git config emits their normal email, just as a manual commit would.

### 7.2 PR Evidence Pack (no PR ships without proof)

**Rule:** Every PR opened by an Obelisk agent must include an Evidence Pack proving the change works. Agents that cannot produce a complete pack do not open the PR — the run pauses and posts the partial result + missing-evidence reason to the source issue for human review.

**Required contents (all that apply):**

| Change type | Required evidence |
|---|---|
| **Bug fix** | (a) the failing test that reproduces the bug, (b) the same test passing after the fix, (c) full test-runner output for the changed package |
| **New feature** | (a) new tests covering the feature (unit + integration as appropriate), (b) full test output, (c) for any UI-visible change: a Playwright screenshot of the feature working end-to-end, (d) for any backend change: a log excerpt or `curl` transcript showing the new code path executing successfully |
| **Refactor / chore** | full test output showing no regressions; if any user-visible surface is touched, a before/after Playwright screenshot of an affected flow |
| **Any change touching UI** | always at least one Playwright screenshot; before/after pair when modifying an existing screen |

**How it is enforced:**
- The agent's final step before publish runs an `evidence-check` that verifies each required artifact exists and is referenced in the PR body. Missing artifacts → run pauses, no PR.
- The PR template auto-rendered by Obelisk includes a fixed `## Evidence` section with subheadings (`Tests`, `Screenshots`, `Logs`, `Reasoning`). Empty subheadings are not allowed; the template lints itself.
- All raw artifacts (test logs, Playwright traces, screenshots, server logs) are stored in `.obelisk/records/prs/<pr-number>/` and linked from the PR body — they are never inlined into commits to keep the diff clean.
- **PR Reviewer** has a hard rule: a PR with an incomplete or fabricated Evidence Pack gets blocked with a `request-changes` review citing exactly which item is missing.

**Why a separate pack instead of "just look at CI":** CI tells you tests passed *somewhere*; the Evidence Pack tells a human reviewer *what* was tested, *what they would see* if they ran it, and *that the agent actually exercised the new code path*. It is the artifact that makes a PR reviewable in 60 seconds instead of 20 minutes.

---

## 8. Success metrics

| Metric | MVP target (90 days post-launch) |
|---|---|
| Time-to-first-issue (connect → first GitHub issue) | < 10 min |
| Time-to-first-merged-PR | < 7 days |
| Issues filed / week / active repo | ≥ 5 |
| Features shipped via Feature Builder / month / active repo | ≥ 1 |
| Issue-to-PR conversion (filed → merged) | ≥ 30% |
| False-positive rate (issues closed as "not a bug") | < 25% |
| Manual QA flows passing nightly / repo | ≥ 80% (target: every critical flow green) |
| QA Playbook adoption (repos with edited `qa/`) | ≥ 50% of active repos by day 30 |
| Active repos at 30 days post-signup | ≥ 60% retention |

---

## 9. Out of scope for the initial release

- Telegram / Slack approval inbox (post-MVP — clear v2 feature).
- Any Obelisk-hosted backend, SaaS tier, or shared multi-tenant deployment. The product is local-first by design.
- Local model support (Qwen3-Coder etc.) — arrives with the OpenHands worker runtime in a future release.
- Linear / Jira sync (read external prioritization, write back PR links).
- Multi-repo orchestration, org-wide dashboards, SSO.
- Chat interface. Chat is secondary; the dashboard is the product.

---

## 10. Key files and surfaces

**Local app data** (Obelisk's per-OS application support directory, e.g. `~/Library/Application Support/Obelisk/` on macOS):

| Surface | Path / location |
|---|---|
| State + audit DB | `obelisk.sqlite` — runs, logs, backlog ordering, settings |
| Secrets | OS keychain — GitHub OAuth token, model API keys (never written to disk in cleartext) |
| Raw artifacts | `records/<repo>/{patches,playwright-traces,screenshots,logs}/` (large files; not committed) |
| App settings | dashboard UI (NOT YAML) |

**In the user's repo** (version-controlled, just like any other project file):

| Surface | Path / location |
|---|---|
| Agent definitions | `agents/*.md` |
| Skill library | `skills/*/` (built-in catalog ships with the app; per-repo files override) |
| QA Playbook | `qa/` (committed at *File issues* mode and above; §3.5) |
| Published audit artifacts | `.obelisk/records/{issues,prs,commits,playwright-traces}/` (only the artifacts referenced from PR/issue bodies) |
| Cloud-execution workflows | `.github/workflows/obelisk-{sweep,manual-qa,fix,feature,review}.yml` (only created if optional cloud execution is enabled) |
| Cloud-execution setup action | `.github/actions/setup-obelisk/action.yml` (only with cloud execution) |

---

## 11. Verification plan

End-to-end smoke test against any small test repo (e.g. a fresh fork of a sample web app the contributor controls):
1. Install Obelisk (download the macOS `.dmg` / Windows `.exe` / Linux AppImage from the project release). Launch the app, sign in to GitHub from the app (OAuth Device Flow), and connect a local clone of the test repo (or clone it through the app).
2. Run wizard with default settings, CLI = Claude Code.
3. Trigger "Run all agents now."
4. Confirm: QA Hunter creates ≥1 issue with repro + suspected files within 10 min.
5. Confirm a `qa/` folder was auto-bootstrapped (product-map, critical-flows with ≥3 flows, expected-behavior, bug-rules, non-bugs) via PR for user approval.
6. Trigger Manual QA. Confirm: ≥1 issue is filed with a Playwright trace + screenshot + console/network logs attached, AND a known-non-bug case (e.g., "free user sees upgrade modal") is NOT filed.
7. Open the Backlog screen, drag a P2 issue to the top. Confirm Bug Fixer picks that issue first on its next run, ignoring lower-ranked P1 issues.
8. Label one issue `obelisk:fix`, wait for Bug Fixer.
9. Confirm: draft PR opens within 30 min with a complete Evidence Pack — failing→passing test diff, full test output, and a Playwright screenshot if any UI was touched.
10. File a one-line feature issue ("Add CSV export to /reports"), label `obelisk:feature`, wait for Feature Builder.
11. Confirm: within 60 min the issue contains a posted spec + plan, and a draft PR exists with vertical-slice commits, a complete Evidence Pack (new tests + output, end-to-end Playwright screenshot of the working feature, server log excerpt), and a self-review comment.
11a. Negative test: manually delete the Playwright screenshot from the agent's output before publish; confirm the run pauses with "Evidence Pack incomplete: missing UI screenshot" and no PR is opened.
12. Open an unrelated PR; confirm PR Reviewer leaves a review comment within 5 min.
13. Repeat steps 2–12 with CLI = Codex (toggle in Settings).
14. Verify audit log contains read/changed files, tests run, skills loaded, Playwright artifacts, and reasoning for every action.
15. Kill the OpenAI key mid-run; verify auto-fallback to Claude Code completes the task.
16. Open any merged Obelisk PR. Confirm: each commit's `Author` matches the local git config (i.e. the connected GitHub account), the `Co-Authored-By: Obelisk` trailer is present, the commit subject ends with `[obelisk:<agent>]`, and the commit appears under the connected user's profile within 24h.
17. Quit the Obelisk app. Confirm: schedules paused (no agent runs occur). Re-launch the app — confirm the scheduler resumes from the last run timestamp without duplicating work.
18. Enable optional cloud execution. Confirm: workflow files are pushed to `.github/workflows/`, a scheduled run dispatches in GitHub Actions, results are read back into the local app, and the same Evidence Pack is attached to any PR opened by the cloud run.

Per-agent unit tests: prompt-compiler snapshot tests for each `(agent, skill-set, runner)` combination, plus a per-skill golden-task test (give skill X to runner Y on fixture repo Z, assert expected diff shape).
