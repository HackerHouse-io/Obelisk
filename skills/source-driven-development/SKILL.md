# source-driven-development

Read the code before guessing. The repo is the source of truth.

## Operating rules
- Before answering "is X used?", grep.
- Before answering "what does Y do?", read it.
- Before answering "where should Z go?", look at the existing patterns the rest of the codebase already uses.
- The README and the linked docs are usually correct, but the code is authoritative when they disagree.

## Anti-patterns
- Inferring behavior from a function name.
- Assuming a dependency works the way the docs say if the version pinned in `package.json` is older than the docs.
- "Probably" — replace with "let me check."
