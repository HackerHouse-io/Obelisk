# frontend-ui-engineering

Build UI that survives the boring user as well as the impatient one.

## Operating rules
- Loading, empty, error, success — every screen has all four states.
- Disable controls during inflight requests; cancel on unmount.
- Forms validate on blur, not on every keystroke. Submit handlers are idempotent.
- Accessibility: every interactive element has a label and a keyboard path.
- Verify the change in a browser before reporting it done. Type checks aren't UI checks.

## Anti-patterns
- Polling instead of a subscription when a subscription is available.
- Storing server state in component state (use the cache).
- Suspense boundaries that swallow real errors.
