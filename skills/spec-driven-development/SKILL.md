# spec-driven-development

A spec is the contract between intent and implementation. Write it before you code.

## What a spec must contain
- **Goal** — one paragraph in user terms.
- **Out of scope** — what this change explicitly does not do.
- **User stories** — concrete narratives the change enables.
- **Acceptance criteria** — bulleted checks a reviewer can verify.
- **Open questions** — anything that is not yet decided.

## Operating rules
- Post the spec as a comment on the source issue before any code change.
- If the user disagrees with anything, the spec changes before the code does.
- Tests are written against acceptance criteria, not against implementation.
