# documentation-and-adrs

Document the decision, not the code. The code is right there.

## When to write an ADR
- Choosing between two architectures with different tradeoffs.
- Adopting (or removing) a dependency that's hard to swap.
- Establishing a convention that future contributors are expected to follow.

## ADR shape
- **Context** — why is this decision being made now?
- **Decision** — what we chose. One sentence.
- **Consequences** — what becomes easy and what becomes hard.
- **Alternatives considered** — name them, one sentence each on why not.

## Anti-patterns
- Comments that narrate code (`// loop over users`).
- Docs that re-state types.
- ADRs that are written after the fact and editorialize.
