# api-and-interface-design

Design the call site first. Implementation follows.

## Operating rules
- Write the example invocation before the function.
- Required arguments come before optional. Defaults are the common case.
- Return shape is consistent across success and failure (e.g. tagged unions, not throw-or-return).
- Names describe behavior, not internals: `getUser`, not `selectFromUserTable`.

## For HTTP APIs
- Resource-oriented. Verbs in the method, nouns in the path.
- Errors return a stable `{ code, message, hint? }` shape.
- Pagination is a cursor, not a page number, when order matters.

## Anti-patterns
- Boolean parameters (caller can't tell what `true` means).
- Output formats that vary based on input (`maybe array, maybe object`).
- Silent overloads — same function, two unrelated jobs.
