# shipping-and-launch

Make the PR reviewable in 60 seconds.

## Operating rules
- PR title ≤ 70 chars, imperative.
- PR description sections, in order: `## Summary` (one paragraph), `## Spec` / `## Plan` (links to issue comments), `## Evidence` (auto-rendered), `## Reasoning`.
- Always open as DRAFT. Auto-merge requires the `obelisk:automerge` label and green checks.
- Link the source issue with `Fixes #<n>` or `Refs #<n>`.

## Anti-patterns
- Long PRs with no `Summary`.
- "WIP" PRs that aren't drafts.
- PR descriptions that just paste the spec — link to it instead.
