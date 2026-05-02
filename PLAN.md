# Obelisk MVP — Implementation Roadmap

## Context

At the time this plan was written, the repository contained only canonical design docs (`PRD.md`, `docs/AGENT_ARCHITECTURE.md`, `docs/TECH_DESIGN.md`, `docs/TEST_PLAN.md`, `README.md`) and a Claude Design handoff bundle (HTML/CSS/React prototypes of the seven UI surfaces). There was no source code yet.

This plan is the roadmap that, once executed, produces a working v0.1 — a local-first Electron + React desktop app that runs five AI coding agents (QA Hunter, Manual QA, Bug Fixer, Feature Builder, PR Reviewer) against a connected GitHub repo, on either Claude Code CLI or Codex CLI, with a complete Evidence Pack pipeline and the seven UI surfaces shown in the Claude Design handoff.

**v0.1 scope (locked):** both runners (Claude + Codex), all four safety modes including auto-merge, **a per-repo actor allowlist** (see "Actor allowlist" below), auto-update via `electron-updater`, all 18 steps of `PRD.md` §11 verification (minus step 18, which covers cloud execution).
**v0.2 (deferred):** optional GitHub Actions cloud execution (`PRD.md` §6 / `TECH_DESIGN.md` §12).

### Actor allowlist (cross-cutting safety control)

A per-repo list of GitHub logins whose issues, PRs, and comments are allowed to **trigger agent runs**. Without this, anyone who can file an issue on a public repo could inject prompts that cause arbitrary CLI invocations on the user's machine. The allowlist is the primary defense against drive-by prompt injection — the Evidence Pack, safety mode, and OAuth scope are downstream defenses but don't stop the run from spending tokens or executing code in the first place.

- **Default contents:** the connected GitHub account's own `login`, auto-added on first connect.
- **Editable** in Settings → "Allowed actors" (add/remove collaborators by GitHub username).
- **Surfaced in the Connect wizard** as a visible step-3 callout: "Agents will only act on issues and PRs from these accounts." User can add more before starting.
- **Enforced at `selectTask`** — every agent that consumes user-supplied GitHub content (Bug Fixer, Feature Builder, PR Reviewer; QA Hunter and Manual QA when they consult an existing issue for dedup) checks `issue.user.login` / `pr.user.login` / `comment.user.login` against the allowlist before doing any work.
- **Audited not silenced:** skipped objects emit `audit_log` rows with `kind='actor_skipped'` (`{ login, reason, source: 'issue#123' | 'pr#456' | 'comment:<id>' }`) so users can see why an agent ignored something.
- **Non-negotiable in MVP** — this is not a v0.2 polish item.

The sequencing strategy is **vertical slice first**: phase 4 ships one end-to-end happy path (Connect repo → Bug Fixer → draft PR with Evidence Pack → Mission Control), then breadth grows. This produces a real demo at ~week 8 and pressures every layer of the substrate before more agents pile on.

The PRD, Tech Design, Agent Architecture, and Test Plan are the canonical specs; this plan does not duplicate them — it sequences the work and names the files that need to exist.

---

## Stack & conventions

| Concern | Choice | Why |
|---|---|---|
| App shell | Electron 31+ | Mandated by PRD §2 ("Electron + React desktop app"). |
| Build/bundle | `electron-vite` | TS-first, Vite-fast renderer + main HMR, integrates with `electron-builder`. |
| Language | TypeScript 5 (strict) | Matches `TECH_DESIGN.md` §3 IPC types. |
| UI framework | React 18 | Per PRD; matches the handoff prototypes. |
| Styling | Plain CSS + design tokens (CSS variables) | Verbatim port of the design handoff's `styles.css`. The design uses class names like `.pill.bad`, `.dot.live`; Tailwind would re-architect the design. |
| Renderer state | Zustand | Light, no boilerplate, fits the bus-event reducer pattern in `TECH_DESIGN.md` §3.2. |
| Routing | React state in root component | Matches the handoff's `app.jsx` (no URLs in a desktop app). |
| DB driver | `better-sqlite3` | Sync API simplifies the audit-log writer; WAL is configurable per `TECH_DESIGN.md` §4. |
| Migrations | `db/migrations/NNN_name.sql` applied at startup | Spec'd by `TECH_DESIGN.md` §4. |
| GitHub API | `@octokit/rest` + `@octokit/plugin-throttling` + `@octokit/plugin-retry` | Spec'd by `TECH_DESIGN.md` §5.4. |
| OAuth | Device Flow (RFC 8628) via Octokit auth-oauth-device | Required because the app has no hosted callback (`TECH_DESIGN.md` §5.1). |
| Secret store | `keytar` under service `com.obelisk.app` | `TECH_DESIGN.md` §5.3. |
| Git operations | `simple-git` for plumbing + `git worktree` via shell for run isolation | Worktree-per-run in `TECH_DESIGN.md` §8.2. |
| Cron parsing | `cron-parser` | `TECH_DESIGN.md` §6. |
| Subprocess | `child_process.spawn` with allow-listed env | `TECH_DESIGN.md` §2.3. |
| Test runners | Vitest (L1/L2), Playwright with `_electron` (L3), `nock` for HTTP cassettes | `TEST_PLAN.md` §1. |
| Packaging | `electron-builder` (mac universal, Windows NSIS, Linux AppImage) | `TECH_DESIGN.md` §13. |
| Auto-update | `electron-updater` against GitHub Releases | `TECH_DESIGN.md` §13. |
| Skill catalog | Vendored `addyosmani/agent-skills` (commit-pinned) | PRD §5.1; per-repo `skills/<name>/SKILL.md` overrides. |
| Code style | ESLint flat config + Prettier | Pre-commit + pre-push hooks per `TEST_PLAN.md` §12. |

**Naming conventions** that recur across the codebase: `RunState` ∈ `queued|running|publishing|done|failed|paused`; `SafetyMode` ∈ `observe|issues|prs|automerge`; `RunnerKind` ∈ `claude|codex`; ULIDs for `runs.id`, `repos.id`, `evidence_artifacts.id`; branches `obelisk/<run-id>`; commit subjects end with `[obelisk:<agent-name>]`.

---

## Repository layout (target end-state)

```
Obelisk/
  package.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig.json  tsconfig.main.json  tsconfig.renderer.json
  src/
    shared/
      types.ts                  # IPC channels, BusEvent, SafetyMode, RunState…
      ipc-channels.ts
      errors.ts                 # ObeliskError + closed enum of error codes
    main/
      index.ts                  # entrypoint; window lifecycle
      ipc/
        register.ts             # ipcMain.handle registry
        auth.ts repos.ts agents.ts runs.ts backlog.ts playbook.ts settings.ts
        bus.ts                  # broadcast helper
      auth/
        device-flow.ts          # OAuth Device Flow against GitHub
        scope-mapper.ts         # SafetyMode → required scopes
        token-store.ts          # keytar wrapper
      github/
        client.ts               # Octokit factory with throttling/retry
        repos.ts issues.ts pulls.ts reviews.ts labels.ts actions.ts
      db/
        index.ts                # better-sqlite3 + WAL
        migrations.ts           # runner that applies db/migrations/*.sql
        repos.ts agents.ts runs.ts audit-log.ts evidence.ts backlog.ts settings.ts
      scheduler/
        tick.ts                 # 30s in-app cron
        heartbeat-reaper.ts
        os-fallback/            # launchd / scheduled-task / systemd installers
      git/
        worktree.ts             # per-run worktree create/remove
        commit.ts push.ts
      runners/
        types.ts                # CodingAgentRunner interface
        claude-code.ts
        codex.ts
        fallback.ts             # 2-fail swap rule
      prompt-compiler/
        index.ts                # compile() pure function
        claude-layout.ts codex-layout.ts
        agent-loader.ts skill-loader.ts repo-summary.ts
        canonical-json.ts hash.ts
      evidence/
        rules.ts                # REQUIRED table from TECH_DESIGN.md §9.1
        infer-change-kind.ts
        artifact-store.ts       # writes to <app-support>/Obelisk/records/
        check.ts                # the publish-time gate
        pr-body.ts              # renders ## Evidence section
      publisher/
        index.ts                # ensureModeAllows → commit → push → open PR
        labels.ts               # obelisk:in-progress lifecycle
        attribution.ts          # commit author/email/co-authored-by/[obelisk:<agent>]
        artifact-mirror.ts      # mirrors to .obelisk/records/ in repo
      agents/
        registry.ts             # name → handler
        types.ts                # Agent interface { selectTask, interpretResult }
        qa-hunter/
        manual-qa/
        bug-fixer/
        feature-builder/
        pr-reviewer/
        playbook-bootstrapper/  # generates qa/ on first connect
      logger/
        audit.ts                # writes audit_log rows
    preload/
      preload.ts                # exposes the IPC API to the renderer
    renderer/
      index.tsx
      app.tsx                   # routing + repo selection (mirror of handoff app.jsx)
      shell/
        Shell.tsx Sidebar.tsx Titlebar.tsx TrafficLights.tsx
      ui/                       # shared primitives ported from handoff ui.jsx
        Modal.tsx Alert.tsx Toast.tsx Dropdown.tsx MenuItem.tsx Tooltip.tsx
        CommandPalette.tsx NotificationsPopover.tsx ModelPickerModal.tsx
      icons.tsx                 # 34 icons from handoff icons.jsx
      screens/
        Home.tsx                # Project Command Center
        MissionControl.tsx      # pipeline + audit drawer
        Backlog.tsx             # drag-to-reorder
        Agents.tsx              # marketplace + detail + ScheduleEditor
        Playbook.tsx            # qa/ editor
        Connect.tsx             # 6-step wizard
        Settings.tsx
      state/
        store.ts                # Zustand root
        runs.ts backlog.ts repos.ts auth.ts settings.ts
        bus-subscriber.ts       # main → renderer event reducer
      styles.css                # verbatim port from handoff
  agents/                       # version-controlled agent definitions (markdown)
    qa-hunter.md  manual-qa.md  bug-fixer.md  feature-builder.md  pr-reviewer.md
  skills/                       # vendored addyosmani/agent-skills (commit-pinned)
    debugging-and-error-recovery/SKILL.md
    test-driven-development/SKILL.md
    ... (21 skills, see PRD §5.1)
  db/migrations/
    001_initial.sql             # all 8 tables from TECH_DESIGN.md §4.1
    002_indexes.sql
  test-fixtures/                # seven fixtures per TEST_PLAN.md §2
    express-buggy/
    react-todo-buggy/
    express-feature-request/
    react-feature-request/
    express-refactor/
    qa-playbook-bootstrap/
    non-bug-trap/
  e2e/
    smoke.spec.ts               # 18-step PRD §11 verification
    fixtures/                   # cassettes, test users
  build/                        # icon, dmg background, etc.
  .github/workflows/
    ci.yml                      # L1 + L2 on every PR
    nightly.yml                 # L2-real + L3 across OS matrix
    release.yml                 # publish dmg/exe/AppImage + auto-update
```

The handoff bundle is **not** vendored as-is — its JSX is React+Babel-CDN prototype code. We re-implement each screen in TypeScript while matching the handoff's visual output and class names from `styles.css` exactly. The handoff's `tweaks-panel.jsx` is design-tooling only and is not ported.

---

## Phased roadmap

Each phase is bounded by a concrete, demonstrable deliverable. A phase is "done" only when its deliverable runs and its tests are green.

### Phase 0 — Scaffold (week 1)
**Deliverable:** `pnpm dev` opens an empty Electron window with the macOS frame from the handoff visible; CI runs and prints "no tests yet."
- Init repo with `electron-vite` template; configure `tsconfig.*`, ESLint flat config, Prettier, Husky pre-commit + pre-push.
- Wire `electron-builder.yml` with placeholder identifiers; `npm run package` produces an unsigned mac/win/linux artifact.
- Stand up GitHub Actions: `ci.yml` (lint + typecheck), placeholder `nightly.yml`, `release.yml` skeleton.
- Add `LICENSE`, badges in `README.md` already present.

### Phase 1 — Substrate: SQLite + IPC + UI shell (weeks 1–3)
**Deliverable:** App opens, sidebar + titlebar (with traffic lights) render in the handoff's exact dark style, switching between empty-state screens via in-renderer routing; SQLite migrations run; the `bus` channel echoes a heartbeat from main to renderer.
- Port the design handoff's `styles.css` to `src/renderer/styles.css` verbatim. Confirm fonts (`Inter`, `JetBrains Mono`) load via a local `@font-face` (no Google CDN at runtime).
- Port `frames/macos-window.jsx` → `src/renderer/shell/MacWindow.tsx` + `TrafficLights.tsx`.
- Port `src/icons.jsx` → `src/renderer/icons.tsx` (34 icons; one factory each).
- Port `src/ui.jsx` primitives (Modal, Alert, Toast, ToastProvider, Dropdown, MenuItem, MenuDivider, MenuLabel, Tooltip, CommandPalette, NotificationsPopover, ModelPickerModal) to typed React components.
- Build the `Shell` (Sidebar with the 7 nav rows, Titlebar with command palette, repo switcher, run-button stub).
- Implement `db/migrations/001_initial.sql` covering all 8 tables in `TECH_DESIGN.md` §4.1 (`repos`, `agents`, `runs`, `audit_log`, `evidence_artifacts`, `backlog`, `settings`, `skill_overrides`, `non_bugs_learned`) **plus** the v0.1-only `actor_allowlist` table (`repo_id TEXT`, `login TEXT`, `added_at TEXT`, `added_by TEXT`, PRIMARY KEY `(repo_id, login)`); wire `src/main/db/migrations.ts` to apply on startup.
- Implement the typed IPC scaffold per `TECH_DESIGN.md` §3: `src/preload/preload.ts` exposing `obelisk.invoke(channel, payload)` and `obelisk.subscribe(handler)`; `src/main/ipc/register.ts` registering all channel handlers from §3.1; `src/main/ipc/bus.ts` for §3.2 broadcasts.
- Implement the closed `ObeliskError` enum in `src/shared/errors.ts` and the `{ ok, value | error }` envelope in every handler.
- Add Zustand root store (`src/renderer/state/store.ts`) + bus subscriber that reduces `BusEvent` into store slices.

### Phase 2 — GitHub auth + Connect Project wizard (weeks 3–4)
**Deliverable:** First-launch flow works end-to-end: user signs in via Device Flow, picks a local clone, picks Observe mode + Claude Code + Balanced schedule, and lands on the Home screen with a real `repos` row in SQLite.
- `src/main/auth/device-flow.ts`: GitHub OAuth Device Flow; exposes `auth:signIn` returning `{ verificationUri, userCode }`, `auth:complete` polling until token issued, `auth:status`, `auth:upgradeScope`.
- `src/main/auth/scope-mapper.ts`: implements the table in `TECH_DESIGN.md` §5.2.
- `src/main/auth/token-store.ts`: keytar wrapper.
- `src/main/github/client.ts`: Octokit with throttling + retry; logs every call to `audit_log` (`kind='api_call'`).
- Port `src/screens/connect.jsx` → `src/renderer/screens/Connect.tsx` as a 6-step wizard matching the handoff exactly:
  1. Sign in (renders user code + verification URI from real Device Flow; copy button; countdown).
  2. Add repo (local-folder picker via `dialog.showOpenDialog`, *or* clone-from-GitHub via `gh.repos.get` + `git clone`).
  3. Safety level (4 cards: Observe / File issues / Open draft PRs / Auto-merge safe) **+ inline "Allowed actors" callout** showing the connected account auto-added, with an "Add more" affordance for collaborators.
  4. CLI runner (Claude Code or Codex; model picker; API-key check via `runner.isInstalled()` and a probe call).
  5. Schedule (3 presets: Observe / Balanced / Aggressive — these populate `agents.schedule_cron` for the 5 default agents).
  6. Start (writes `repos`, `agents`×5, default `settings`, **and an `actor_allowlist` row for the connected user's login**; transitions to Home).
- API-key entry routes to keychain via a new IPC channel `auth:setRunnerKey`.

### Phase 3 — Prompt compiler + dual-runner runtime (weeks 4–5)
**Deliverable:** Given a fixture repo + a fixture agent + a fixture task, the compiler produces a deterministic `CompiledPrompt` (snapshot test green) and both `ClaudeCodeRunner` and `CodexRunner` execute against `test-fixtures/express-buggy/` and return a `RunResult` with a non-empty patch.
- `src/main/prompt-compiler/`: pure compile function per `TECH_DESIGN.md` §7. Sorts skill files, emits canonical JSON, hashes inputs into `contentHash`. Writes Claude layout (`.claude/skills/<name>/SKILL.md` + `--system-prompt-file`) vs. Codex layout (inlined skills + runner args).
- `src/main/agents/<name>/definition.md` files (one per agent) parsed via gray-matter front-matter.
- Skill loader resolves per-repo override → vendored catalog → fail.
- `src/main/runners/types.ts`: the `CodingAgentRunner` interface from `TECH_DESIGN.md` §8.1.
- `src/main/runners/claude-code.ts`: spawns `claude` CLI; `isInstalled()` runs `claude --version`.
- `src/main/runners/codex.ts`: spawns `codex exec`; `isInstalled()` runs `codex --version`.
- `src/main/runners/fallback.ts`: tracks `(task_ref, runner) → fail_count`; swaps after 2 same-task crashes.
- `src/main/git/worktree.ts`: per-run worktree under `<app-support>/Obelisk/worktrees/<repo-id>/<run-id>/` branched from `default_branch`.
- L1 snapshot tests for `(agent ∈ 5, runner ∈ 2)` = 10 prompt snapshots.

### Phase 4 — First end-to-end agent: Bug Fixer + Evidence Pack + publisher + Mission Control (weeks 6–8) — **THE VERTICAL SLICE**
**Deliverable demo:** Label an issue `obelisk:fix` in `test-fixtures/express-buggy/`. The Bug Fixer wakes up on a manual `Run now`, opens a worktree, writes a failing test, fixes the bug, packs evidence, opens a draft PR with the standard `## Evidence` block, and the run animates through Mission Control's Backlog → Investigating → Reproduced → Fixing → Verifying → PR Created lanes.
- `src/main/agents/bug-fixer/`: handler implementing `selectTask` (top of backlog filtered to `kind='bug'`, not `in_progress`, **AND `issue.user.login` ∈ `actor_allowlist`** — non-allowlisted items are skipped with `audit_log kind='actor_skipped'`) and `interpretResult` (extracts failing-test diff, test output, screenshots-if-UI-touched).
- `src/main/agents/lib/actor-allowlist.ts`: single shared check used by every agent's `selectTask`. Reads `actor_allowlist` for the repo, returns `{ ok: true } | { ok: false, login, reason }`. Audit-logs every skip.
- `src/main/evidence/`: implements the rule engine from `TECH_DESIGN.md` §9.1 with the four `ChangeKind` mappings; `infer-change-kind.ts` infers from touched files + agent name; `check.ts` is the publish-time gate that pauses the run if any required item is missing; `pr-body.ts` renders the four-subheading `## Evidence` section.
- `src/main/publisher/`: `ensureModeAllows()` re-check, `commit()` using local git config (`TECH_DESIGN.md` §7.1 attribution), `push()` to `obelisk/<run-id>`, `openPR()` (draft), `applyLabels()` (`obelisk:in-progress`), `artifact-mirror.ts` mirroring referenced artifacts to `.obelisk/records/prs/<pr#>/`.
- Port `src/screens/mission.jsx` → `src/renderer/screens/MissionControl.tsx`: 7-stage pipeline, run cards, the 460px right drawer with 4 tabs (Audit, Evidence, Reasoning, Files) — all reactive to `bus` events `run.transition` and `run.audit`.
- Port `src/screens/home.jsx` → `src/renderer/screens/Home.tsx` (read-only, populated from real DB queries).
- L2 integration tests for Bug Fixer happy path + 3 failure modes (`REPRO_FAILED`, `EVIDENCE_INCOMPLETE`, `PUSH_REJECTED`) per `TEST_PLAN.md` §5.

### Phase 5 — QA Hunter + QA Playbook bootstrapper + Backlog UI (weeks 8–9)
**Deliverable:** On first connect to a clean fixture repo, a `chore(obelisk): bootstrap QA playbook` PR is opened; on a scheduled tick, QA Hunter files real issues with severity, repro, suspected files; the Backlog screen lists them and supports drag-to-reorder, pin-to-top, and per-row "send to fixer now."
- `src/main/agents/qa-hunter/`: handler; default skills `code-review-and-quality`, `debugging-and-error-recovery`, `test-driven-development`, `security-and-hardening`.
- `src/main/agents/playbook-bootstrapper/`: implements `TECH_DESIGN.md` §10 — discover routes (sitemap → framework manifests → BFS crawl), discover test users (seeds → factories → propose), generate the 6 `qa/*.md` + `qa/playwright/flows/*.flow.md` stubs. Mode-aware delivery (preview store in Observe; PR in higher modes).
- `src/main/db/backlog.ts`: read/write order; ranking signals from `PRD.md` §3.6 (`user_pin_rank` → `priority_label` → recency); `agent_override` and `runner_override` per row.
- Port `src/screens/backlog.jsx` → `src/renderer/screens/Backlog.tsx` with HTML5 drag-and-drop wired to `backlog:reorder` IPC.
- L2 tests including the `qa-playbook-bootstrap/` and dedup-against-existing-issue cases from `TEST_PLAN.md` §5.1.

### Phase 6 — Manual QA (Playwright) (weeks 9–10)
**Deliverable:** Manual QA reads `qa/critical-flows.md`, runs each flow via Playwright, captures trace + screenshot + console + network, files an issue only when `repro_confidence ≥ 0.7` and the symptom is not in `non-bugs.md`. The `non-bug-trap/` fixture asserts no false positive.
- `src/main/agents/manual-qa/`: handler; default skills `browser-testing-with-devtools`, `debugging-and-error-recovery`. Default runner Codex.
- Playwright is a peer dependency of the user's repo, not bundled — runner discovers it from the local clone's `node_modules` and shells out via the user's `pnpm exec playwright`/`npx playwright`.
- Trace + screenshot artifacts land in `evidence_artifacts` rows; the issue body links them via local file URIs handled by the desktop app's `obelisk://` protocol.

### Phase 7 — Feature Builder (weeks 10–11)
**Deliverable:** A one-line issue labeled `obelisk:feature` produces a posted spec → posted plan → vertical-slice commits → draft PR with new tests, full output, end-to-end screenshot, and a server-log/curl excerpt — all per `AGENT_ARCHITECTURE.md` §4.4.
- `src/main/agents/feature-builder/`: each loop step (`define`, `plan`, `build`, `test`, `review`) is a discrete CLI invocation with its own compiled prompt; state persists between steps via issue comments + `audit_log`. `selectTask` runs the actor-allowlist check on the source issue's author; if a `obelisk:continue` comment author is non-allowlisted, the resume is rejected.
- Resume-from-step on `obelisk:continue`.
- Test-loop cap of 3 with `error_code='TEST_LOOP_EXHAUSTED'`.

### Phase 8 — PR Reviewer (week 11)
**Deliverable:** Every opened PR (including Obelisk's own) gets a review within 5 min; PRs with empty/fabricated `## Evidence` blocks are hard-blocked with `REQUEST_CHANGES` citing the missing item.
- `src/main/agents/pr-reviewer/`: cross-checks evidence by resolving each link in the `## Evidence` section against `evidence_artifacts` and the repo's `.obelisk/records/`. `selectTask` filters PRs to `pr.user.login ∈ actor_allowlist` (Obelisk's own bot identity is auto-allowlisted so it reviews its own PRs).
- Webhook-style trigger via short-poll on `gh.pulls.list` (no webhook server — local-first).

### Phase 9 — Remaining UI surfaces (weeks 11–12)
**Deliverable:** All seven screens in the handoff render real data and are fully interactive.
- Port `src/screens/agents.jsx` → `src/renderer/screens/Agents.tsx`: marketplace list, detail pane, the full `ScheduleEditor` (event/recurring/cron/manual modes with the spring-animated segmented control), guardrails, schedule preview.
- Port `src/screens/extras.jsx` → `src/renderer/screens/Playbook.tsx` and `src/renderer/screens/Settings.tsx`. Settings includes safety mode (triggers `auth:upgradeScope`), runner default, attribution mode (User-attributed / Bot-attributed / Custom), API-key management, **an "Allowed actors" panel** (list, add by GitHub username with Octokit `users.getByUsername` validation, remove), and the cloud-execution toggle (disabled in v0.1 with a "v0.2" badge).
- Wire the Home screen's "Needs your review" / "Live activity" / "Up next" / "Agents" cards to real DB queries.

### Phase 10 — Scheduler hardening + auto-merge (week 12)
**Deliverable:** Schedules fire on cadence with the app open; OS-level fallback (launchd/Task Scheduler/systemd) processes due runs with the app closed; auto-merge mode actually merges a green PR with the `obelisk:automerge` label.
- `src/main/scheduler/tick.ts`: 30s `setInterval`; per-`(repo,agent)` next-fire computation; live-run dedup.
- `src/main/scheduler/heartbeat-reaper.ts`: stale-run reaper.
- `src/main/scheduler/os-fallback/`: per-OS installers writing the launch agent / scheduled task / systemd unit; headless mode invocable as `Obelisk --headless tick` holding `<app-support>/Obelisk/scheduler.lock`.
- Auto-merge gate in publisher: requires mode `automerge` AND label `obelisk:automerge` AND green checks; otherwise notification only.

### Phase 11 — Test infrastructure (weeks 11–13, in parallel with later agent work)
**Deliverable:** L1 + L2 green on every PR in <4 min; L2-real + L3 release-blocking suites green nightly across mac/win/linux.
- L1: prompt-compiler snapshots, scheduler arithmetic, evidence-rule engine, scope mapper, label parsers, migrations runner.
- L2: per-agent happy-path + 3 failure-mode cases per `TEST_PLAN.md` §5; `MockRunner` keyed by `contentHash`; `nock` cassettes per fixture; a recording harness behind `pnpm test:record <fixture>`. **Plus a dedicated actor-allowlist suite**: for each of Bug Fixer / Feature Builder / PR Reviewer, assert (a) allowlisted author → run proceeds, (b) non-allowlisted author → run is skipped with `audit_log kind='actor_skipped'` and zero side effects (no commit, push, comment, label change, or evidence write).
- L2-real: 10 golden tasks tagged `@real-cli` with $5/day token-spend cap; budget-overflow fails the build.
- L3: Playwright + `_electron` driving the packaged binary through the `e2e/smoke.spec.ts` mapping of all 17 PRD §11 steps (step 18 deferred to v0.2).
- Pre-commit (L1 on touched files) + pre-push (full L1 + L2) hooks via Husky; CI is the authoritative gate.

### Phase 12 — Packaging, signing, auto-update, release (weeks 13–14)
**Deliverable:** Signed `.dmg` (universal), signed `.exe` (NSIS), `AppImage` published as `v0.1.0` to GitHub Releases; first install successfully auto-updates to a follow-up `v0.1.1` patch.
- `electron-builder.yml`: macOS notarization via `notarytool`, Windows code-signing (EV cert), AppImage build.
- `electron-updater` against GitHub Releases; `stable` and opt-in `nightly` channels.
- `release.yml` GitHub Action: tag-triggered build matrix → upload artifacts → publish release.
- First-run flow per `TECH_DESIGN.md` §13: welcome screen → Device Flow → Connect Project wizard.
- SBOM generation via `cyclonedx-npm` published with the release per `TECH_DESIGN.md` §14.1.

---

## Critical files (existence-of-MVP checklist)

These files MUST exist and be wired before v0.1 can ship. Use this as a final sweep.

**Substrate**
- `package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `tsconfig.*`
- `src/shared/types.ts`, `src/shared/errors.ts`, `src/shared/ipc-channels.ts`
- `src/preload/preload.ts`
- `src/main/index.ts`, `src/main/ipc/register.ts`, `src/main/ipc/bus.ts`
- `src/main/db/index.ts`, `src/main/db/migrations.ts`, `db/migrations/001_initial.sql`

**Auth + GitHub**
- `src/main/auth/device-flow.ts`, `src/main/auth/scope-mapper.ts`, `src/main/auth/token-store.ts`
- `src/main/github/client.ts` + per-resource modules

**Runner + compiler + git**
- `src/main/prompt-compiler/index.ts` (+ `claude-layout.ts`, `codex-layout.ts`, hash + canonical JSON)
- `src/main/runners/{types,claude-code,codex,fallback}.ts`
- `src/main/git/{worktree,commit,push}.ts`

**Evidence + publisher**
- `src/main/evidence/{rules,infer-change-kind,artifact-store,check,pr-body}.ts`
- `src/main/publisher/{index,labels,attribution,artifact-mirror}.ts`

**Agents** (each: `definition.md` + handler + default skills + tests)
- `src/main/agents/lib/actor-allowlist.ts` — shared safety gate, called by every agent's `selectTask`
- `src/main/agents/{qa-hunter,manual-qa,bug-fixer,feature-builder,pr-reviewer,playbook-bootstrapper}/`
- `agents/{qa-hunter,manual-qa,bug-fixer,feature-builder,pr-reviewer}.md`
- `skills/` — vendored catalog, 21 skills

**Scheduler**
- `src/main/scheduler/{tick,heartbeat-reaper}.ts`, `src/main/scheduler/os-fallback/{darwin,win32,linux}.ts`

**Renderer (every screen + the shell)**
- `src/renderer/styles.css` (verbatim from handoff)
- `src/renderer/icons.tsx`
- `src/renderer/shell/{Shell,Sidebar,Titlebar,TrafficLights,MacWindow}.tsx`
- `src/renderer/ui/{Modal,Alert,Toast,Dropdown,MenuItem,Tooltip,CommandPalette,NotificationsPopover,ModelPickerModal}.tsx`
- `src/renderer/screens/{Home,MissionControl,Backlog,Agents,Playbook,Connect,Settings}.tsx`
- `src/renderer/state/{store,bus-subscriber}.ts`

**Tests**
- `test-fixtures/{express-buggy,react-todo-buggy,express-feature-request,react-feature-request,express-refactor,qa-playbook-bootstrap,non-bug-trap}/`
- `e2e/smoke.spec.ts`

**Release**
- `.github/workflows/{ci,nightly,release}.yml`
- `build/icon.icns`, `build/icon.ico`, `build/icon.png` (use `assets/obelisk-icon.png` as source)

---

## Reuse — what we don't write from scratch

| Capability | Source | Notes |
|---|---|---|
| 21 senior-engineer playbook skills | `addyosmani/agent-skills` | Vendored at a pinned commit under `skills/`. PRD §5.1 calls for shipping the catalog wholesale. The companion `slavingia/skills` library is **not** used (per memory: business skills, not relevant). |
| All visual design — tokens, layout, primitives, screen layouts | Claude Design handoff bundle (provided privately to contributors with implementation access) | Re-implement in TS+React but match pixel-for-pixel. `styles.css` is ported verbatim; class names like `.pill.bad`, `.dot.live` are kept. |
| Mock data shapes | Handoff `src/data.jsx` | Inform DB shape. The handoff's `MOCK.AGENTS` schema is already reflected in `TECH_DESIGN.md` §4.1. |
| OAuth Device Flow | `@octokit/auth-oauth-device` | Don't hand-roll; the library handles polling, slow-down, pending state per RFC 8628. |
| GitHub API resilience | `@octokit/plugin-throttling` + `@octokit/plugin-retry` | Already specified by `TECH_DESIGN.md` §5.4. |
| Cron parsing | `cron-parser` | For `nextFireAt` calculations in the scheduler. |
| Git plumbing | `simple-git` | Plus shell-out for `git worktree` (not exposed by simple-git). |
| Electron packaging + auto-update | `electron-builder` + `electron-updater` | Don't hand-roll a release pipeline. |

---

## Verification

A v0.1 release candidate is verified by **all of the following passing**:

1. **Automated regression suites green** on macOS-latest, windows-latest, ubuntu-latest:
   - L1 unit (`pnpm test`) — coverage ≥ 90% on `src/main/**`, ≥ 80% overall.
   - L2 integration with `MockRunner` + `nock` cassettes — every per-agent happy path + 3 failure modes from `TEST_PLAN.md` §5.
   - L2-real `@real-cli` golden tasks — under the $5/day budget cap.
   - L3 Playwright + Electron smoke (`e2e/smoke.spec.ts`) covering 17 of the 18 steps in `PRD.md` §11 (step 18 / cloud execution deferred to v0.2).

2. **Manual end-to-end smoke**, walked by hand once per release, against `test-fixtures/react-todo-buggy/`:
   - Connect → first GitHub issue in < 10 min (PRD success metric).
   - **Actor-allowlist negative test:** an outside collaborator (login NOT in `actor_allowlist`) opens an issue labeled `obelisk:fix`. Bug Fixer's next tick MUST skip it, write `audit_log kind='actor_skipped'`, and produce no run. Then add the collaborator to the allowlist in Settings; on the next tick the run proceeds normally.
   - QA Playbook PR opens with ≥ 3 flow files.
   - Manual QA files an issue for the seeded persistence bug AND does **not** file an issue for the upgrade-modal non-bug.
   - Drag a P2 to the top of Backlog → Bug Fixer picks it next.
   - A `obelisk:fix`-labeled issue produces a draft PR with all four populated `## Evidence` subheadings within 30 min.
   - A one-line `obelisk:feature` issue produces spec + plan + draft PR within 60 min.
   - Negative test (PRD §11 step 11a): manually delete the screenshot from the agent's output → run pauses with `EVIDENCE_INCOMPLETE`, no PR opens.
   - PR Reviewer leaves a review on an unrelated PR within 5 min.
   - Repeat the entire run with `runner='codex'`.
   - Kill the OpenAI key mid-run → auto-fallback to Claude Code completes the task.
   - Quit and relaunch the app between scheduled ticks → no run is duplicated, none is missed.
   - Auto-merge: a green draft PR with `obelisk:automerge` + mode `automerge` actually merges; same PR without the label does not.
   - Commit attribution: each Obelisk-produced commit has Author = local git config, trailer `Co-Authored-By: Obelisk`, subject ends `[obelisk:<agent>]`.

3. **Distribution sanity check:**
   - Signed `.dmg` opens on a fresh macOS, passes Gatekeeper, completes Device Flow on first launch.
   - Signed `.exe` installs on a fresh Windows VM, passes SmartScreen.
   - `.AppImage` is portable on a fresh Ubuntu LTS.
   - First install successfully auto-updates to a published patch release.

When all three pass, tag `v0.1.0` and publish via `release.yml`.
