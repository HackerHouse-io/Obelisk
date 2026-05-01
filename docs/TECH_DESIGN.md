# Obelisk — Technical Design

**Status:** Draft for the initial release.
**Audience:** Contributors implementing Obelisk.
**Source of requirements:** [`../PRD.md`](../PRD.md). This document describes *how*; the PRD describes *what* and *why*. Where the two disagree, the PRD wins until reconciled.

---

## 1. System overview

Obelisk is a **local-first desktop application** (Electron + React) that integrates with GitHub from the user's machine. Nothing in this diagram runs on Obelisk-operated infrastructure.

```
┌────────────────────────────────────────────────────────────────────┐
│  Electron renderer (React UI)                                      │
│  Project Command Center · Agent Marketplace · Mission Control      │
│  Backlog · QA Playbook editor · Settings                           │
└────────────▲───────────────────────────────────────────▲───────────┘
             │                IPC (typed)                │
┌────────────┴───────────────────────────────────────────┴───────────┐
│  Electron main process (local control plane)                       │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ GitHub OAuth   │  │ Scheduler    │  │ State + audit (SQLite) │  │
│  │ (Device Flow,  │  │ in-app cron  │  │ runs · backlog ·       │  │
│  │  keychain)     │  │ + OS task    │  │ settings · audit_log   │  │
│  └────────────────┘  └──────────────┘  └────────────────────────┘  │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Prompt compiler│  │ Job runner   │  │ Evidence-check + git   │  │
│  │ agent + skills │  │ spawns CLI   │  │ commit/push/PR via API │  │
│  │  → CLI prompt  │  │ subprocess   │  │                        │  │
│  └────────────────┘  └──────┬───────┘  └────────────────────────┘  │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ child_process.spawn
                ┌─────────────▼──────────────┐
                │  CLI subprocess            │
                │  `claude` or `codex`       │
                │  cwd = local repo clone    │
                │  stdin = compiled prompt   │
                └────────────────────────────┘

         (Optional, off by default)
                              ▼
                ┌────────────────────────────┐
                │  GitHub Actions (user repo)│
                │  obelisk-*.yml workflows   │
                │  Same agents, same Pack    │
                └────────────────────────────┘
```

| Component | Process | Owner concerns |
|---|---|---|
| Renderer | Electron renderer | UI rendering only; no disk/network/keychain access. |
| GitHub auth | Main | Device-Flow login, scope upgrades, token in keychain. |
| Scheduler | Main | Fires runs on cadence; survives quit via OS-level fallback. |
| State store | Main | SQLite database with WAL; sole owner of run + audit data. |
| Prompt compiler | Main | Pure function: agent + skills + task → CLI-specific prompt. |
| Job runner | Main | Spawns CLI subprocess, enforces timeouts, captures output. |
| CLI subprocess | Child of main | Edits files, runs tests/Playwright in user's dev env. |
| Evidence + publisher | Main | Validates Evidence Pack, commits via local git, calls GitHub API. |
| Cloud workflows | GitHub Actions runner | Only when user enables optional cloud execution (PRD §6). |

---

## 2. Process model

**Three process tiers**, sandboxed by Electron + OS conventions.

### 2.1 Renderer (React)

- **No** Node integration (`nodeIntegration: false`), context isolation on (`contextIsolation: true`), preload script exposes only an explicit IPC API.
- The renderer cannot read files, spawn subprocesses, or call the GitHub API directly. All of these go through main via IPC.
- Single window for v1; multi-repo views are tabs in one window.

### 2.2 Main process

- Owns SQLite, keychain access, the GitHub API client, scheduler, job runner, and FS access to repo clones.
- Crash policy: any unhandled exception in main is logged to `audit_log`, the offending run is marked `failed`, the renderer is notified, and the app continues running.
- Long-running responsibilities (scheduler tick, file watchers) survive renderer reloads.

### 2.3 CLI subprocess (per agent run)

- Spawned via `child_process.spawn` with:
  - `cwd` = the local repo clone for the connected repo (per-run isolated through git worktrees; see §8.2).
  - `env` = a *whitelist* — `PATH`, `HOME`, `LANG`, the chosen runner's API-key env var, and nothing else. The user's broader env (other API keys, secrets) is not inherited.
  - `stdio: ['pipe', 'pipe', 'pipe']` — stdin gets the compiled prompt, stdout/stderr stream into the audit log line-by-line.
  - `detached: false`, `signal: AbortController` for timeout/cancel.
- Lifetime is bounded by `agents.timeoutMs` (default 30 min for fixers, 60 min for Feature Builder).

---

## 3. IPC surface

All IPC is typed via a shared `types.ts` and uses Electron's `ipcMain.handle` / `ipcRenderer.invoke` pattern (request/response). Renderer never uses `send` for fire-and-forget. Broadcasts from main to renderer go through `webContents.send` on a single `bus` channel with a discriminated-union payload.

### 3.1 Request channels (renderer → main)

| Channel | Request | Response | Notes |
|---|---|---|---|
| `auth:status` | `()` | `{ signedIn, login, scope }` | Reads keychain. |
| `auth:signIn` | `()` | `{ verificationUri, userCode }` | Starts Device Flow. |
| `auth:complete` | `()` | `{ login, scope }` | Polls until token received. |
| `auth:upgradeScope` | `{ to: SafetyMode }` | `{ scope }` | Re-runs Device Flow with broader scopes. |
| `repos:list` | `()` | `Repo[]` |  |
| `repos:connect` | `{ localPath?, githubFullName? }` | `Repo` | Either pick a local clone or clone via API. |
| `repos:setMode` | `{ repoId, mode }` | `Repo` | Changes safety mode; may trigger `auth:upgradeScope`. |
| `agents:list` | `{ repoId }` | `Agent[]` |  |
| `agents:run` | `{ repoId, agentName, taskId? }` | `{ runId }` | Manual trigger. |
| `agents:cancel` | `{ runId }` | `{ ok }` |  |
| `runs:list` | `{ repoId, limit, before? }` | `Run[]` | Pagination. |
| `runs:get` | `{ runId }` | `Run & { auditLog, evidence }` |  |
| `backlog:list` | `{ repoId }` | `BacklogItem[]` |  |
| `backlog:reorder` | `{ repoId, orderedIds }` | `{ ok }` |  |
| `backlog:setOverride` | `{ itemId, runner?, agent? }` | `BacklogItem` |  |
| `playbook:get` | `{ repoId }` | `Playbook` | `qa/` files + dashboard-only draft if Observe. |
| `playbook:save` | `{ repoId, files }` | `{ ok }` | Writes to repo (or to draft store in Observe). |
| `settings:get` | `()` | `Settings` |  |
| `settings:update` | `Partial<Settings>` | `Settings` |  |

### 3.2 Broadcast channel (main → renderer): `bus`

```ts
type BusEvent =
  | { type: 'run.created'; run: Run }
  | { type: 'run.transition'; runId: string; state: RunState; at: ISO }
  | { type: 'run.audit'; runId: string; line: AuditLine }
  | { type: 'backlog.changed'; repoId: string }
  | { type: 'auth.changed'; signedIn: boolean }
  | { type: 'evidence.missing'; runId: string; missing: EvidenceItem[] }
```

Renderer subscribes once at startup; reducers in renderer state apply events.

### 3.3 Error model

All handlers return `{ ok: true, value }` or `{ ok: false, error: { code, message, hint? } }`. Codes are a closed enum (`AUTH_REQUIRED`, `MODE_TOO_LOW`, `TOKEN_EXPIRED`, `RUNNER_NOT_INSTALLED`, `EVIDENCE_INCOMPLETE`, …). Renderer maps codes to user-facing messages.

---

## 4. State store (SQLite schema)

Single SQLite file at `<app-support>/Obelisk/obelisk.sqlite`, opened with `journal_mode = WAL` and `foreign_keys = ON`. Migrations live in `db/migrations/NNN_name.sql`, applied at startup.

### 4.1 Tables

```sql
-- Each connected repo.
CREATE TABLE repos (
  id              TEXT PRIMARY KEY,           -- ulid
  github_full_name TEXT NOT NULL UNIQUE,      -- "owner/name"
  local_path      TEXT NOT NULL,
  default_branch  TEXT NOT NULL,
  mode            TEXT NOT NULL,              -- observe | issues | prs | automerge
  default_runner  TEXT NOT NULL,              -- claude | codex
  connected_at    TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_repos_full_name ON repos(github_full_name);

-- Per-repo agent installation + per-agent overrides.
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,              -- qa-hunter | manual-qa | bug-fixer | feature-builder | pr-reviewer
  enabled         INTEGER NOT NULL DEFAULT 1,
  runner_override TEXT,                       -- NULL = use repo default
  schedule_cron   TEXT,                       -- NULL = use built-in default for this agent
  timeout_ms      INTEGER NOT NULL,
  UNIQUE(repo_id, name)
);

-- One row per agent run, regardless of outcome.
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL,
  state           TEXT NOT NULL,              -- queued | running | publishing | done | failed | paused
  started_at      TEXT,
  finished_at     TEXT,
  trigger         TEXT NOT NULL,              -- schedule | manual | webhook
  task_ref        TEXT,                       -- e.g. issue#123, pr#456
  runner_used     TEXT NOT NULL,
  fallback_used   INTEGER NOT NULL DEFAULT 0,
  output_summary  TEXT,                       -- 1-line "what happened"
  error_code      TEXT,
  worktree_path   TEXT
);
CREATE INDEX idx_runs_repo_agent_started ON runs(repo_id, agent_name, started_at DESC);

-- Append-only run log; one row per significant event.
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,              -- state | tool_call | file_read | file_write | test_run | api_call | reasoning
  payload         TEXT NOT NULL               -- JSON
);
CREATE INDEX idx_audit_log_run ON audit_log(run_id, id);

-- Files produced by a run: patches, screenshots, traces, logs.
CREATE TABLE evidence_artifacts (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,              -- patch | test_output | screenshot | trace | log | reasoning
  path            TEXT NOT NULL,              -- under <app-support>/records/<repo>/<run-id>/
  bytes           INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  uploaded_to_repo INTEGER NOT NULL DEFAULT 0 -- 1 if mirrored to .obelisk/records/...
);

-- Prioritized backlog feeding Bug Fixer + Feature Builder.
CREATE TABLE backlog (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,              -- gh_issue | manual
  github_issue    INTEGER,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,              -- bug | feature
  priority_label  TEXT,                       -- P0 | P1 | P2 | NULL
  user_pin_rank   INTEGER,                    -- NULL = not pinned
  agent_override  TEXT,                       -- name of forced agent
  runner_override TEXT,                       -- claude | codex | NULL
  in_progress_run TEXT REFERENCES runs(id),   -- non-null = locked
  added_at        TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_backlog_repo_rank ON backlog(repo_id, user_pin_rank, priority_label, added_at DESC);

-- App-wide and per-repo settings.
CREATE TABLE settings (
  scope           TEXT NOT NULL,              -- 'app' | 'repo:<id>'
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,              -- JSON
  PRIMARY KEY (scope, key)
);

-- Per-repo skill overrides catalog (mirrors files in repo/skills/).
CREATE TABLE skill_overrides (
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  skill_name      TEXT NOT NULL,
  source_path     TEXT NOT NULL,              -- absolute path under repo
  PRIMARY KEY (repo_id, skill_name)
);

-- Learned QA rules from user accept/reject decisions.
CREATE TABLE non_bugs_learned (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  rule            TEXT NOT NULL,              -- prose rule
  source_run      TEXT REFERENCES runs(id),
  added_at        TEXT NOT NULL
);
```

### 4.2 Retention

- `runs` rows kept indefinitely; `audit_log` rows older than 180 days are summarized to a single `digest` row per run and the granular events are deleted.
- `evidence_artifacts` files have a soft cap (1 GB per repo by default, configurable). Eviction is LRU by `runs.finished_at`, never deletes the latest 50 runs.
- All retention is local; the user can wipe a repo's data with one Settings action.

---

## 5. GitHub authentication & API client

### 5.1 Why OAuth Device Flow (not GitHub App)

A GitHub App requires a centrally-hosted backend to receive webhooks and hold a private key. Obelisk has no such backend. An **OAuth App with Device Flow** (RFC 8628) is the only mechanism that gives a desktop client a refreshable user token without a hosted callback URL.

The OAuth App is registered once by the project (free, no infra). Each user signs in to *their own* GitHub account through it; the resulting token belongs to the user, lives only in their keychain, and grants exactly the scopes their current safety mode requires.

### 5.2 Scope mapping

| Safety mode (PRD §3.2) | Required OAuth scopes |
|---|---|
| Observe only | `read:user`, `repo:status`, `public_repo` (read-only) — for private repos: `repo` is required by GitHub for any read on private; we then enforce read-only at the API client. |
| File issues | + `issues:write` (covered by `repo` for private; for public, `public_repo` covers issues). |
| Fix bugs and build features | + `pull_requests:write`, `contents:write` (covered by `repo`). |
| Auto-merge safe fixes | Same scopes; auto-merge is gated client-side, not by scope. |

**Mode upgrade triggers a re-authorize prompt.** The renderer shows a non-dismissible modal, the main process re-runs Device Flow with the broader scope set, and only swaps the keychain entry on success.

### 5.3 Token storage

- Stored via `keytar` under service `com.obelisk.app`, account `<github-login>`.
- Never persisted to SQLite or disk.
- Cleared on sign-out and on `auth:upgradeScope` failure.

### 5.4 API client

- Uses `@octokit/rest` with `@octokit/plugin-throttling` and `@octokit/plugin-retry`.
- Hard rules:
  - Read endpoints retry on 5xx with exponential backoff capped at 60s.
  - Write endpoints **never** retry on 5xx — surface to user.
  - Secondary rate-limit (`abuse-detection`) → pause all in-flight runs for 60s, post a notification.
- All API calls are logged in `audit_log` (kind=`api_call`) with the redacted URL, method, response code, and latency.

---

## 6. Scheduler

### 6.1 In-app cron (app open)

A single `setInterval(tick, 30_000)` in main process. Each tick:

1. Read `agents` rows for all enabled agents across all connected repos.
2. For each, compute `nextFireAt` from `schedule_cron` (or built-in default per agent: PRD §6.2).
3. If `nextFireAt <= now` and there is no live run for that `(repo_id, agent_name)` pair (look up in `runs WHERE state IN ('queued','running','publishing')`), enqueue.
4. Job runner picks up queued runs (one at a time per repo, configurable parallelism for cross-repo).

Heartbeat: while a run is live, the runner writes `now()` to `runs.last_heartbeat_at` every 10s. Stale runs (no heartbeat for >2× timeout) are reaped to `failed` on next tick.

### 6.2 OS-level fallback (app closed)

When the user enables "Run schedules even when Obelisk is closed":

- **macOS:** install a launch agent at `~/Library/LaunchAgents/com.obelisk.scheduler.plist` that invokes `Obelisk.app/Contents/MacOS/Obelisk --headless tick` every 5 minutes.
- **Windows:** create a Scheduled Task (`Obelisk Scheduler`) with the same headless invocation.
- **Linux:** install a systemd user unit + timer (`obelisk-scheduler.service` / `.timer`).

Headless mode:

- Runs the same scheduler tick, processes any due runs, writes results to SQLite, exits.
- Holds an OS-level file lock on `<app-support>/Obelisk/scheduler.lock` so two ticks can't overlap (whether app is open or not).

### 6.3 De-duplication

Compound key `(repo_id, agent_name, hour-bucket)` — at most one scheduled run per agent per repo per hour-bucket. Manual triggers bypass the bucket but still respect the live-run check.

---

## 7. Prompt compiler

### 7.1 Inputs

```ts
type CompileInput = {
  agent: AgentDefinition         // parsed agents/<name>.md
  skills: SkillDefinition[]      // resolved built-in + per-repo overrides
  task: TaskPayload              // issue/PR ref + extracted context
  repoContext: RepoSummary       // README excerpt, package.json, qa/ summary,
                                 //   recent commits, changed files since last run
  runnerKind: 'claude' | 'codex'
  permissions: Permissions       // derived from current safety mode
}
```

### 7.2 Output

```ts
type CompiledPrompt = {
  systemPrompt: string           // role + constraints + permissions
  userMessage: string            // task + context
  attachments: Attachment[]      // skill SKILL.md files, qa/*.md, etc.
  runnerArgs: string[]           // CLI-specific flags (--codex-model, etc.)
  contentHash: string            // sha256 of the full normalized payload
}
```

### 7.3 CLI-specific layout

| Aspect | `ClaudeCodeRunner` | `CodexRunner` |
|---|---|---|
| Skills | Materialized as `<worktree>/.claude/skills/<name>/SKILL.md`; the `claude` CLI auto-loads. | Inlined into `userMessage` as fenced sections under `## Skills`. |
| System prompt | Passed via `--system-prompt-file`. | Prepended to `userMessage`. |
| Tool permissions | Encoded into `.claude/settings.json` written before spawn. | Encoded into runner args (`--codex-sandbox`, etc.). |
| Reasoning effort | Default; per-agent override via env. | `--codex-reasoning-effort=<level>`. |

### 7.4 Determinism

- Skill files are sorted by name; agent definition fields are emitted in canonical order.
- `contentHash` is computed over the normalized JSON of inputs (excluding wall-clock fields).
- Snapshot tests assert that `compile(sameInputs) === sameContentHash`.

---

## 8. Job runner & CLI subprocess contract

### 8.1 Interface

```ts
interface CodingAgentRunner {
  readonly kind: 'claude' | 'codex'
  isInstalled(): Promise<{ ok: boolean; version?: string; hint?: string }>
  run(opts: RunOpts, abort: AbortSignal): Promise<RunResult>
}

type RunOpts = {
  worktreePath: string
  prompt: CompiledPrompt
  apiKeyEnv: { name: string; value: string }
  timeoutMs: number
  onAudit: (line: AuditLine) => void
}

type RunResult =
  | { ok: true; patch: GitPatch; testsRun: TestRun[]; reasoning: string }
  | { ok: false; reason: 'timeout' | 'crash' | 'non_zero_exit' | 'no_changes'; detail: string }
```

### 8.2 Working-tree isolation

Each run executes in its own **git worktree** under `<app-support>/Obelisk/worktrees/<repo-id>/<run-id>/`, branched from the repo's default branch at run start. The worktree is the CLI's `cwd`. After the run:

- If `ok=true` and the patch is non-empty, the worktree's branch is pushed to origin (`obelisk/<run-id>`) and a draft PR is opened.
- The worktree is removed on success or kept for one debug retention window (24h) on failure.
- Concurrent runs against the same repo each get their own worktree; the user's primary checkout is never touched.

### 8.3 Auto-fallback

If a runner returns `ok=false` with `reason='crash'` or `non_zero_exit` **twice in a row** for the same task (same `task_ref`), the next attempt swaps to the other runner (Claude→Codex or Codex→Claude). `runs.fallback_used = 1` is set. After 4 total attempts across both runners, the run is marked `failed` and the source issue gets a comment with the audit log link.

---

## 9. Evidence Pack pipeline

PRD §7.2 defines the contract. Implementation:

### 9.1 Required-artifact rules

```ts
type ChangeKind = 'bug_fix' | 'new_feature' | 'refactor' | 'ui_only'

const REQUIRED: Record<ChangeKind, EvidenceItem[]> = {
  bug_fix:    ['failing_test_diff', 'test_output', 'ui_screenshot_if_ui_touched'],
  new_feature:['new_tests',         'test_output', 'ui_screenshot_if_ui_touched',
                                                   'backend_log_or_curl_if_backend_touched'],
  refactor:   ['test_output',       'before_after_screenshot_if_ui_touched'],
  ui_only:    ['ui_screenshot'],
}
```

`ChangeKind` is inferred from the patch (touched files + agent name).

### 9.2 The check

After a successful run, before pushing or opening a PR:

1. For each required item, look up the corresponding `evidence_artifacts` row by `kind`.
2. If any required item is missing or has `bytes=0`, the run transitions to `paused`, posts a comment on the source issue (`Evidence Pack incomplete: missing <items>`), and **does not** open a PR.
3. If all required items are present, render the PR body with a fixed `## Evidence` section containing four subheadings (`Tests`, `Screenshots`, `Logs`, `Reasoning`); each subheading lists the relevant artifacts with links.

### 9.3 Storage

- Local: every artifact goes to `<app-support>/Obelisk/records/<repo-id>/<run-id>/<kind>/<filename>`. SHA256 stored in `evidence_artifacts`.
- Repo: the publisher mirrors only the artifacts referenced in the PR body to `.obelisk/records/{prs|issues|commits}/<id>/`. Large traces live local-only and are linked via the local file URI in the PR body for reviewers running Obelisk; non-Obelisk reviewers see "trace stored locally — open Obelisk to view."

---

## 10. QA Playbook bootstrapper

PRD §3.5 defines the artifact. Bootstrap fires on first connect or on demand from Settings. Steps:

1. **Discover routes.** Look for `sitemap.xml`, then framework-specific manifests (`next.config`, `react-router` route trees, `routes.rb`, FastAPI `app.routes`). Fallback: launch the dev server and crawl from `/`, BFS to depth 3.
2. **Discover test users.** Look for `seed.sql`, `seeds/`, factory files. If none, propose `normal_user` / `admin_user` with a placeholder password and require the contributor to fill them in.
3. **Generate `qa/` files.**
   - `product-map.md`: one-paragraph repo summary derived from README + top-level dirs.
   - `critical-flows.md`: a short list (≤5) of high-value flows: login, primary CRUD, billing if applicable.
   - `expected-behavior.md`: stub per flow, populated via small Playwright probe runs.
   - `bug-rules.md`: copy of the universal oracle list.
   - `non-bugs.md`: empty.
   - `playwright/flows/<flow>.flow.md`: one stub per critical flow.
4. **Mode-aware delivery.** In Observe mode, files live only in `playbook` IPC table for renderer preview. In *File issues* and above, the bootstrapper opens a PR titled `chore(obelisk): bootstrap QA playbook` for human review.

---

## 11. Mission Control / Backlog data flow

- Both views are reactive: renderer subscribes to the `bus` channel (§3.2).
- On `run.transition` and `run.audit`, the affected run row in the renderer's local store is updated; Mission Control re-renders the affected pipeline lane.
- On `backlog.changed`, the renderer re-fetches the full ordered list (small N, cheap).
- For long lists (>500 backlog items), the renderer uses windowed virtualization; main exposes `backlog:listPaged`.

---

## 12. Optional cloud execution

Default: off. Enabling it from Settings does the following:

### 12.1 Workflow files written

| Path | Purpose |
|---|---|
| `.github/actions/setup-obelisk/action.yml` | Composite action: `npm i -g @anthropic-ai/claude-code` (or `@openai/codex`), inject API key from secrets, `gh auth setup` for the run-scoped token. |
| `.github/workflows/obelisk-sweep.yml` | QA Hunter on schedule. |
| `.github/workflows/obelisk-manual-qa.yml` | Manual QA on schedule (Playwright). |
| `.github/workflows/obelisk-fix.yml` | Bug Fixer; triggers on `obelisk:fix` label. |
| `.github/workflows/obelisk-feature.yml` | Feature Builder; triggers on `obelisk:feature` label. |
| `.github/workflows/obelisk-review.yml` | PR Reviewer on every PR. |

Each workflow does the same thing as a local run: setup CLI → compile prompt → run agent → produce Evidence Pack → publish.

### 12.2 Repo secrets

- `OBELISK_RUNNER_API_KEY` — required for any cloud run.
- `OBELISK_ALLOW_EXECUTE`, `OBELISK_ALLOW_FIX_PR`, `OBELISK_ALLOW_MERGE` — secret-presence gates the corresponding actions inside the workflow. Their *absence* is the off state.

### 12.3 Reconciliation

Local app polls `GET /repos/{owner}/{repo}/actions/runs?event=schedule` every 5 min when cloud execution is on. For each new run that maps to an Obelisk workflow, it:

1. Writes a `runs` row with `trigger='cloud'`.
2. Downloads workflow logs and Evidence Pack artifacts via the API.
3. Imports them into local `audit_log` and `evidence_artifacts`.

UI-side, cloud and local runs render identically in Mission Control.

---

## 13. Packaging & distribution

| Target | Tool | Notes |
|---|---|---|
| macOS `.dmg` | `electron-builder` | Universal binary (x64 + arm64). Code-signed with Developer ID, notarized via `notarytool`. |
| Windows `.exe` | `electron-builder` (NSIS) | Code-signed (EV cert preferred to avoid SmartScreen warm-up). |
| Linux `AppImage` | `electron-builder` | Single-file portable. `.deb` and `.rpm` are nice-to-have, not release-blocking. |

Auto-update via `electron-updater` against the project's GitHub Releases. Update channel = `stable`; nightly builds publish to `nightly` and require an opt-in toggle.

First-run flow:

1. Show one-screen welcome. No telemetry prompt — there is no telemetry.
2. Click *Sign in to GitHub* → Device Flow: app shows the user code and opens the browser to `github.com/login/device`.
3. After successful auth, drop into the **Connect Project** wizard (PRD §3.2).

---

## 14. Security model

- **No Obelisk-operated network endpoints.** All network I/O is GitHub API calls and CLI vendor API calls (Anthropic / OpenAI), both authenticated with user-controlled tokens stored in OS keychain.
- **Renderer is sandboxed.** No node integration, context isolation on, preload script exposes only the IPC API listed in §3.
- **CLI subprocess sees only what it needs.** Working dir is a per-run worktree (§8.2); env is allow-listed (§2.3); the only API key in the env is the chosen runner's.
- **OAuth scope is the primary safety gate.** A token issued for *Observe only* mode physically lacks the scopes to push or open PRs; the API will reject those calls regardless of bugs in the local code path. The local job runner re-checks mode before any state-changing call as belt-and-suspenders (§14.2 below).
- **Mode downgrade mid-run aborts cleanly.** If `repos.mode` is changed while a run is live, the runner aborts on its next checkpoint and rolls back its worktree.
- **Evidence-check is a publish-time gate.** No PR opens with a missing artifact (§9). PR Reviewer is configured to hard-block PRs with incomplete Evidence Packs even if a future bug let one slip through.
- **Auto-update is signed.** `electron-updater` verifies signatures against the platform certificate; mismatched updates are refused.
- **No telemetry, no analytics, no remote logs.** Crash reports are written to `<app-support>/Obelisk/crash-reports/` and only sent to the project if the user manually attaches one to a GitHub issue.

### 14.1 Threat model (brief)

| Threat | Mitigation |
|---|---|
| Compromised user machine | Out of scope — same trust boundary as the user's local terminal. |
| Malicious agent output | Worktree isolation + Evidence Pack gate + draft-PR default + human merge. |
| Token exfiltration via dependency | Renderer cannot read keychain; main has no `eval`/dynamic require; SBOM published with releases. |
| Bug in mode-gating code | Defense in depth: OAuth scope is the authoritative gate; local check is secondary. |

### 14.2 Local mode re-check

Pseudocode for any state-changing call (`gh api`, `git push`, etc.):

```ts
async function ensureModeAllows(repoId, action) {
  const mode = await db.repos.getMode(repoId)
  if (!ACTION_PERMITTED[mode].includes(action)) {
    throw new ObeliskError('MODE_TOO_LOW', `Action ${action} not allowed in ${mode}`)
  }
}
```

`ACTION_PERMITTED` is a closed table; adding a new action requires touching it explicitly.
