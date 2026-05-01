<p align="center">
  <img src="assets/obelisk-icon.png" alt="Obelisk" width="180" />
</p>

<h1 align="center">Obelisk</h1>

<p align="center">
  <em>Your repo finally maintains itself.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/status-early%20development-orange" alt="Early development" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Cross-platform" />
</p>

---

Obelisk is an open-source desktop app that runs a small fleet of AI coding agents against your GitHub repo. Connect a repo, pick agents, set how much they're allowed to do, and walk away. You come back to filed issues with repro steps, draft PRs with passing tests, and PR review comments — all on the user's own machine, with the user's own API keys.

Not a chatbot. A mission-control dashboard for a background engineering team.

## What it does

| Agent | What it does | Output |
|---|---|---|
| **QA Hunter** | Reads code, runs tests, surfaces weak spots and likely bugs. | GitHub issue with severity, repro, suspected files |
| **Manual QA** | Drives the app like a user via Playwright against a written QA Playbook. | Issue with trace, screenshot, console + network logs |
| **Bug Fixer** | Picks a labeled issue, writes a failing test, fixes it. | Draft PR with an Evidence Pack (test diff, output, screenshots) |
| **Feature Builder** | DEFINE → PLAN → BUILD → TEST → REVIEW → SHIP from a one-line issue. | Draft PR with spec, plan, vertical-slice diff, tests, evidence |
| **PR Reviewer** | Reviews every PR on five axes: correctness, design, tests, security, perf. | PR approve / block / comment |

## How it works

| Layer | Detail |
|---|---|
| **App** | Electron + React desktop app. Runs entirely on your machine. |
| **CLI runner** | Pluggable. Ships with **Claude Code CLI** and **Codex CLI** as first-class options, selectable per agent or globally. |
| **State** | Local SQLite for runs, audit logs, backlog. OS keychain for tokens and API keys. |
| **GitHub** | OAuth Device Flow on first launch. Issues, PRs, reviews via the REST API. |
| **Execution** | Local subprocess by default. Optional cloud execution via your own GitHub Actions runners for 24/7 schedules. |
| **No backend** | No hosted service, no telemetry, no multi-tenant cloud. Your code and keys never leave your machine. |

## Safety levels

Each level adds the actions of the previous one. Start at the top and graduate when you're comfortable.

1. **Observe only** — Agents read code, run tests, crawl the app. Findings appear in the dashboard as previews. Nothing is written to GitHub or the repo.
2. **File issues** — Agents may create real GitHub issues with repro steps.
3. **Fix bugs and build features** — Agents may also open *draft* PRs. A human still merges.
4. **Auto-merge safe fixes** — Obelisk may merge a green draft PR that matches a safe-fix policy.

Every agent action lands in an audit log complete enough that a reviewer can verify it without re-running anything.

## Status

Obelisk is in early development. The architecture, agents, and screens are designed; the app is being built in the open. Expect rough edges, expect things to change. Issues and discussion are welcome.

## Documentation

| Document | What's in it |
|---|---|
| [PRD.md](PRD.md) | Product requirements, scope, user flows, screens |
| [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md) | Agent definitions, skill library, runner interface |
| [docs/TECH_DESIGN.md](docs/TECH_DESIGN.md) | App architecture, scheduler, state, IPC |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | How Obelisk itself is tested |

## License

[MIT](LICENSE). Bring your own API keys; bring your own opinions.
