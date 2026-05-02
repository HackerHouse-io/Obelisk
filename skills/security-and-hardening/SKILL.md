# security-and-hardening

Treat untrusted input as hostile. Validate at boundaries, never in the middle.

## Boundaries to scrutinize
- HTTP request handlers and parsers (body, query, headers).
- Subprocess invocations — never interpolate untrusted strings into a shell.
- Database query construction — parameterize, never concatenate.
- File paths derived from user input — resolve and check that the result is inside the expected root.
- Authorization on every protected handler — implicit ownership checks lie.

## Secrets
- Never log a token, key, or password — even in error paths.
- Don't commit them. Don't send them to error trackers.
- Read secrets from the OS keychain or a secret store, never from disk in cleartext.

## Anti-patterns
- "We trust this caller" — internal callers can be wrong.
- `eval`, `Function()`, dynamic `require` of untrusted strings.
- Disabling SSL verification "just for now."
