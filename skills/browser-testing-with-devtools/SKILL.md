# browser-testing-with-devtools

Drive the application like a real user. Capture evidence the human reviewer can replay.

## Per flow
- Launch Playwright against the configured base URL.
- Execute the steps from the flow's `*.flow.md`.
- Record: trace (`.zip`), full-page screenshot, console messages, failed network requests.
- Compare actuals against `qa/expected-behavior.md`.

## Filing rules
- Match the symptom against `qa/non-bugs.md` first. If matched, do NOT file.
- Only file when `repro_confidence >= 0.7`.
- Issue body must include the trace, screenshot, console excerpt, and exact repro steps.

## Anti-patterns
- Filing on the first transient failure — re-run once before deciding.
- Filing without a Playwright trace.
- Reproducing a bug locally that the CI environment can't.
