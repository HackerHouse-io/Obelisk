# code-review-and-quality

Review code along five axes and flag only real problems.

## Five axes
1. **Correctness** — does the change do what it claims? Edge cases? Off-by-one? Null?
2. **Design** — right layer? right abstraction? Will the next caller hate this?
3. **Tests** — would a regression be caught? Are tests honest about what they verify?
4. **Security** — untrusted input boundaries, authz checks, secret handling, injection.
5. **Performance** — accidental N+1, O(n²), unbounded loops, large reads.

## Operating rules
- One inline comment per real finding. No nitpicks bundled together.
- Cite specific lines. Never "this file" — always `path:line`.
- For each finding, propose a concrete fix or a single clarifying question.
- Be blunt about real problems; be generous with explanation.
