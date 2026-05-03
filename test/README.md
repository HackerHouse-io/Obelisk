# Tests

Test infrastructure for Obelisk. Source of truth for the strategy: `docs/TEST_PLAN.md`.

## Layers

| Layer | Scope | Where | Runs on |
|---|---|---|---|
| **L1** | Pure functions: prompt compiler, scheduler arithmetic, evidence rules, parsers, type guards. | `test/main/*.test.ts` | Every push (pre-push hook + CI). Sub-second per file. |
| **L2** | Orchestrator + agent handlers end-to-end against a fixture repo, with `MockRunner` and a stubbed Octokit (`vi.mock('../../src/main/github/client')`). | `test/main/orchestrator-*.test.ts` | Every push. < 30s total. |
| **L2-real** | Real CLIs (`claude` / `codex`) against fixture repos. Tagged `@real-cli`, gated by API-key env vars. | not yet checked in | Nightly (Phase 12+). $5/day token cap. |
| **L3** | Playwright + `_electron` driving the packaged binary through the PRD §11 verification steps. | not yet checked in | Nightly + release-blocking (Phase 12). |

## Running

```bash
pnpm test                 # L1 + L2 with mocks (the gate that pre-push runs)
pnpm test:watch           # L1 + L2 in watch mode
pnpm verify               # typecheck + lint + format:check + test (the CI gate)
```

The `pretest` and `posttest` hooks rebuild `better-sqlite3` and `keytar` for the
host Node ABI before tests and back to Electron's ABI after — so `pnpm dev`
keeps working without a manual rebuild.

## Test helpers

- `test/helpers/mock-runner.ts` — `MockRunner implements CodingAgentRunner`. Recipes
  describe files to write/delete; the runner applies them to the worktree and
  reports the resulting git diff as a `RunResult`.
- Stubbed Octokit — failure-mode tests `vi.mock('../../src/main/github/client')`
  with a hand-rolled fake whose call shape matches the publisher's needs. This
  is more robust than HTTP-level mocking against Node's native `fetch`.

## Fixtures

The `TEST_PLAN.md` §2 fixture catalog (express-buggy, react-todo-buggy, etc.)
will be checked in incrementally as their consumers land. For now, L2 tests
construct minimal git repos in `tmpdir()` per-test — see `makeFixtureRepo()` in
`test/main/orchestrator-failure-modes.test.ts` for the pattern.

## Coverage status (v0.1)

- ✅ Prompt compiler: snapshot per `(agent, runner)` × determinism
- ✅ Evidence rule engine: every row of the §7.2 table
- ✅ Backlog ranking: pin → priority → recency
- ✅ Scheduler cron + heartbeat reaper
- ✅ Per-agent output parsers (QA Hunter, Manual QA, Feature Builder, PR Reviewer)
- ✅ Failure modes: EVIDENCE_INCOMPLETE, TIMEOUT, no_changes (both PR-opening + read-only), MODE_TOO_LOW
- ⏳ Auto-merge integration: deferred (needs Octokit mocking)
- ⏳ L2-real golden tasks: deferred (needs CI API keys + budget gate)
- ⏳ L3 Playwright + Electron smoke: deferred (large infra)
- ⏳ Per-fixture cassettes: deferred until fixtures land

## When tests fail in CI but pass locally

The `pre-push` hook runs `pnpm verify` — the same script CI runs. If a test
passes locally but fails in CI, the most likely causes are:

1. **Native module ABI**: keytar's `libsecret-1.so.0` is installed in CI explicitly
   via `apt-get install`. If you add a new native dep, make sure it has a Linux
   runtime story.
2. **Time-of-day**: scheduler tests use `tz: 'UTC'` to be DST-stable; if your
   local TZ matters, you have a bug.
3. **Random state**: every test uses a fresh `tmpdir()` and `setDbPathForTesting`,
   so cross-test pollution shouldn't happen. If you see flakes, look for
   module-level state in the file under test.
